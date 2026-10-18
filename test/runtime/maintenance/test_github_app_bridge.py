"""Offline evidence regressions: fake GitHub only, never call a credential broker or the network."""
import copy
import runpy
import unittest
from pathlib import Path

module = runpy.run_path(str(Path(__file__).resolve().parents[3] / 'scripts/maintenance/github-app-bridge.py'))
verify = module['verify']
material_hash = module['material_hash']
comment_hash = module['comment_hash']
read_issue = module['read_issue']

BASE, SHA = 'a' * 40, 'b' * 40
REPO, LOGIN = 'example/project', 'example-app[bot]'
JOB_ID = 'maint-' + 'c' * 32
ORIGINAL = {'id': 11, 'body': 'Real acceptance criterion', 'user': {'login': 'owner'}}
ISSUE = {'number': 7, 'title': 'Fix regression', 'body': 'Acceptance requirements', 'labels': [],
         'user': {'login': 'owner'}, 'state': 'closed', 'comments': 2}
RESOLUTION = {'id': 12, 'body': '[maintenance-job:' + JOB_ID + '] Verified ' + SHA,
              'user': {'login': LOGIN}}
REQUEST = {'job': {'id': JOB_ID, 'startingCommit': BASE, 'issues': [{'number': 7,
            'materialHash': material_hash(ISSUE), 'comments': [{'id': '11', 'hash': comment_hash(ORIGINAL)}]}]},
           'result': {'issues': [{'number': 7, 'disposition': 'fixed', 'commits': [SHA]}]},
           'branch': 'main', 'requiredWorkflows': ['checks.yml']}


class Fake:
    def __init__(self):
        self.issue = copy.deepcopy(ISSUE)
        self.comments = [copy.deepcopy(ORIGINAL), copy.deepcopy(RESOLUTION)]
        self.run = {'id': 100, 'head_sha': SHA, 'head_branch': 'main', 'head_repository': {'full_name': REPO},
                    'event': 'push', 'status': 'completed', 'conclusion': 'success'}
        self.ancestry = True
        self.calls = []

    def gh(self, args):
        self.calls.append(args)
        return {}

    def api(self, path, paginate=False):
        self.calls.append((path, paginate))
        if '/branches/' in path:
            return {'commit': {'sha': SHA}}
        if '/comments?' in path:
            return [[self.comments[0]], self.comments[1:]]
        if '/issues/' in path:
            return self.issue
        if '/actions/' in path:
            return {'workflow_runs': [self.run]}
        if '/compare/' in path:
            base = path.split('/compare/')[1].split('...')[0]
            return {'status': 'ahead' if self.ancestry else 'diverged', 'merge_base_commit': {'sha': base}}
        raise AssertionError('Unexpected API route')

    def proof(self):
        return verify(self.api, self.gh, REPO, REQUEST, LOGIN)


class EvidenceTests(unittest.TestCase):
    def test_all_comments_and_exact_ci_are_verified(self):
        f = Fake()
        p = f.proof()
        self.assertTrue(p['issues'][0]['materialMatches'])
        self.assertTrue(p['issues'][0]['linkedResolution'])
        self.assertEqual(p['commits'][0]['ci'], 'passed')
        self.assertTrue(p['commits'][0]['pushed'])
        self.assertIn(['issue', 'view', '7', '--repo', REPO, '--json', 'title,body,comments,labels,state'], f.calls)

    def test_edited_or_deleted_original_comment_invalidates_acceptance(self):
        f = Fake(); f.comments[0]['body'] = 'Changed criterion'
        self.assertFalse(f.proof()['issues'][0]['materialMatches'])
        f.comments = [copy.deepcopy(RESOLUTION)]; f.issue['comments'] = 1
        self.assertFalse(f.proof()['issues'][0]['materialMatches'])

    def test_new_human_clarification_cannot_be_silently_ignored(self):
        f = Fake(); f.comments.append({'id': 13, 'body': 'New acceptance', 'user': {'login': 'owner'}}); f.issue['comments'] = 3
        self.assertFalse(f.proof()['issues'][0]['materialMatches'])

    def test_resolution_from_another_author_or_job_is_not_trusted(self):
        f = Fake(); f.comments[1]['user']['login'] = 'stranger'
        self.assertFalse(f.proof()['issues'][0]['linkedResolution'])
        f.comments[1] = {**RESOLUTION, 'body': 'Different job: ' + SHA}
        self.assertFalse(f.proof()['issues'][0]['linkedResolution'])

    def test_wrong_commit_branch_repository_event_and_failed_ci_are_not_pass(self):
        for field, value in [('head_sha', BASE), ('head_branch', 'other'), ('head_repository', {'full_name': 'other/repo'}), ('event', 'pull_request')]:
            f = Fake(); f.run[field] = value
            self.assertEqual(f.proof()['commits'][0]['ci'], 'missing')
        f = Fake(); f.run['conclusion'] = 'failure'
        self.assertEqual(f.proof()['commits'][0]['ci'], 'failed')
        f.run['status'] = 'in_progress'
        self.assertEqual(f.proof()['commits'][0]['ci'], 'pending')

    def test_ancestry_is_not_inferred_from_a_commit_claim(self):
        f = Fake(); f.ancestry = False
        self.assertFalse(f.proof()['commits'][0]['descendedFromStart'])
        self.assertFalse(f.proof()['commits'][0]['pushed'])

    def test_incomplete_comment_pages_fail_closed(self):
        f = Fake(); f.issue['comments'] = 3
        with self.assertRaises(RuntimeError):
            read_issue(f.api, f.gh, REPO, 7)


if __name__ == '__main__':
    unittest.main()
