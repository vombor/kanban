#!/usr/bin/env python3
"""Maintainer-only evidence bridge. Operator supplies an existing App-only helper; no token is returned."""
import hashlib
import json
import re
import runpy
import subprocess
import sys
from urllib.parse import quote


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def comment_hash(comment):
    return digest({'id': str(comment['id']), 'body': comment['body'], 'author': comment['user']['login']})


def material_hash(issue):
    return digest({'title': issue['title'], 'body': issue['body'], 'author': issue['user']['login'],
                   'labels': sorted(label['name'] for label in issue['labels'])})


def read_issue(api, gh, repository, number):
    # Keep the project's agreed issue-view shape, and independently ensure comments are not truncated by GraphQL.
    gh(['issue', 'view', str(number), '--repo', repository, '--json', 'title,body,comments,labels,state'])
    issue = api('repos/' + repository + '/issues/' + str(number))
    pages = api('repos/' + repository + '/issues/' + str(number) + '/comments?per_page=100', paginate=True)
    comments = [item for page in pages for item in page]
    if len(comments) != issue['comments'] or len(comments) > 1000:
        raise RuntimeError('Complete issue comment evidence unavailable')
    return issue, comments


def same_or_ahead(api, repository, base, head):
    comparison = api('repos/' + repository + '/compare/' + base + '...' + head)
    return comparison['status'] in ('ahead', 'identical') and comparison['merge_base_commit']['sha'] == base


def verify(api, gh, repository, request, login):
    job, result = request['job'], request['result']
    branch = request['branch']
    if not re.fullmatch(r'[A-Za-z0-9_./-]{1,200}', branch):
        raise RuntimeError('Invalid branch')
    if not re.fullmatch(r'maint-[a-f0-9]{32}', job['id']):
        raise RuntimeError('Invalid job identity')
    workflows = request['requiredWorkflows']
    if not 1 <= len(workflows) <= 10 or any(not re.fullmatch(r'[A-Za-z0-9_.-]+\.ya?ml', w) for w in workflows):
        raise RuntimeError('Invalid CI policy')
    base = job['startingCommit']
    commits = sorted({sha for item in result['issues'] if item['disposition'] == 'fixed' for sha in item['commits']})
    if not re.fullmatch(r'[a-f0-9]{40}', base) or any(not re.fullmatch(r'[a-f0-9]{40}', sha) for sha in commits):
        raise RuntimeError('Invalid commit identity')
    head = api('repos/' + repository + '/branches/' + quote(branch, safe=''))['commit']['sha']
    issue_proofs = []
    for original in job['issues']:
        issue, comments = read_issue(api, gh, repository, original['number'])
        current = {str(c['id']): comment_hash(c) for c in comments}
        material_matches = material_hash(issue) == original['materialHash'] and all(current.get(c['id']) == c['hash'] for c in original['comments'])
        original_ids = {c['id'] for c in original['comments']}
        new_comments = [c for c in comments if str(c['id']) not in original_ids]
        marker = '[maintenance-job:' + job['id'] + ']'
        # Only this job's bot receipts may be appended without invalidating the original acceptance evidence.
        material_matches = material_matches and all(c['user']['login'] == login and marker in c['body'] for c in new_comments)
        report = next(item for item in result['issues'] if item['number'] == original['number'])
        linked = report['disposition'] == 'fixed' and any(c['user']['login'] == login and marker in c['body'] and all(sha in c['body'] for sha in report['commits']) for c in new_comments)
        issue_proofs.append({'number': original['number'], 'closed': issue['state'] == 'closed', 'materialMatches': material_matches, 'linkedResolution': linked})
    commit_proofs = []
    for sha in commits:
        states, urls = [], []
        for workflow in workflows:
            runs = api('repos/' + repository + '/actions/workflows/' + quote(workflow, safe='') + '/runs?head_sha=' + sha + '&per_page=100')['workflow_runs']
            candidates = [r for r in runs if r['head_sha'] == sha and r['head_branch'] == branch and r['head_repository']['full_name'] == repository and r['event'] == 'push']
            run = max(candidates, key=lambda r: r['id']) if candidates else None
            if run is None:
                states.append('missing')
            elif run['status'] != 'completed':
                states.append('pending')
            elif run['conclusion'] != 'success':
                states.append('failed')
            else:
                states.append('passed')
                urls.append('https://github.com/' + repository + '/actions/runs/' + str(run['id']))
        ci = 'failed' if 'failed' in states else 'missing' if 'missing' in states else 'pending' if 'pending' in states else 'passed'
        commit_proofs.append({'sha': sha, 'descendedFromStart': sha != base and same_or_ahead(api, repository, base, sha),
                              'pushed': same_or_ahead(api, repository, sha, head), 'ci': ci, 'urls': urls})
    return {'issues': issue_proofs, 'commits': commit_proofs}


def perform(request, helper, container):
    repository = request['repository']
    if repository != helper['REPOSITORY'] or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise RuntimeError('Helper does not authorize this repository')
    broker = helper['BROKER'].replace("contents:'write'", "contents:'read'")
    grant = "...(installation.permissions?.workflows==='write'?{workflows:'write'}:{})"
    if grant not in broker:
        raise RuntimeError('Unsupported App helper contract; do not guess or widen its permissions')
    broker = broker.replace(grant, "issues:'read',actions:'read'")
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', container):
        raise RuntimeError('Invalid operator-selected broker container')
    response = subprocess.run(['podman', 'exec', '-e', 'NODE_DEBUG=', '-i', container, 'node', '--input-type=module', '-'],
                              input=broker, capture_output=True, text=True, env=helper['clean_env'](), timeout=60)
    if response.returncode:
        raise RuntimeError('App read credential unavailable')
    access = json.loads(response.stdout)
    if not access.get('login', '').endswith('[bot]') or not access.get('token'):
        raise RuntimeError('Unexpected App identity')
    def gh(args):
        return json.loads(helper['run_gh'](access, args))
    def api(path, paginate=False):
        args = ['api', '--hostname', 'github.com', path]
        if paginate:
            args.extend(['--paginate', '--slurp'])
        return gh(args)
    if request['operation'] == 'issues':
        issues = gh(['issue', 'list', '--repo', repository, '--state', 'open', '--limit', '101', '--json', 'number'])
        if len(issues) > 100:
            raise RuntimeError('Admission issue ceiling exceeded')
        snapshots = []
        for item in issues:
            issue, comments = read_issue(api, gh, repository, item['number'])
            if issue['state'] != 'open' or 'pull_request' in issue:
                raise RuntimeError('Issue changed during admission')
            snapshots.append({'number': item['number'], 'materialHash': material_hash(issue),
                              'comments': [{'id': str(c['id']), 'hash': comment_hash(c)} for c in comments]})
        return snapshots
    if request['operation'] == 'verify':
        return verify(api, gh, repository, request, access['login'])
    raise RuntimeError('Unsupported read-only operation')


if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.read(128 * 1024 + 1))
        helper = runpy.run_path(sys.argv[1])
        print(json.dumps(perform(request, helper, sys.argv[2])))
    except Exception:
        # Including subprocess/parse errors: never emit a token, upstream body, command environment or traceback.
        print(json.dumps({'error': 'app_read_evidence_unavailable'}))
        raise SystemExit(1)
