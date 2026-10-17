import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const python = spawnSync("python3", ["--version"]);
describe.skipIf(python.error || python.status !== 0)("GHCR preflight", () => {
	it("checks upload authorization and handles unsupported cleanup without exposing credentials", () => {
		const script = `
import contextlib, io, json, os, runpy, sys, urllib.error, urllib.request
module = runpy.run_path(sys.argv[1])
os.environ.update(IMAGE='ghcr.io/vombor/kanban', GHCR_USER='example[bot]', GHCR_TOKEN='private-job-token')
class Response:
    def __init__(self, status, body=b'', headers=None): self.status, self.body, self.headers = status, body, headers or {}
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self): return self.body
calls=[]
location='/v2/vombor/kanban/blobs/upload/probe?private-query=retained'
cancel_status=204
def request(req, timeout):
    if req.full_url.startswith('https://api.github.com/'):
        return Response(200,b'{"id":123,"full_name":"vombor/kanban","repository":{"id":123,"full_name":"vombor/kanban"}}')
    calls.append(req)
    if len(calls)==1: return Response(200,b'{"token":"opaque-private-registry-token"}')
    if len(calls)==2: return Response(202,headers={'Location':location})
    if cancel_status!=204: raise urllib.error.HTTPError(req.full_url,cancel_status,'private-server-response',{},None)
    return Response(204)
urllib.request.urlopen=request
output=io.StringIO()
with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output): result=module['main']()
assert result==0
assert [r.get_method() for r in calls]==['GET','POST','DELETE']
assert calls[1].get_header('Authorization')=='Bearer opaque-private-registry-token'
assert calls[2].full_url=='https://ghcr.io'+location
assert 'private' not in output.getvalue()
assert json.loads(output.getvalue().splitlines()[-1])['preflightUploadCancelled'] is True
for location in ['/v2/vombor/kanban/blobs/uploads/probe','https://ghcr.io/v2/vombor/kanban/blobs/upload/probe']:
    calls.clear()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output): result=module['main']()
    assert result==0 and len(calls)==3
for location in ['https://evil.example/v2/vombor/kanban/blobs/upload/probe',
                 'http://ghcr.io/v2/vombor/kanban/blobs/upload/probe',
                 '/v2/other/repository/blobs/upload/probe',
                 '/v2/vombor/kanban/blobs/upload/probe#private-fragment']:
    calls.clear()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        try: module['main']()
        except ValueError as error: assert str(error)=='Unexpected registry upload location'
        else: raise AssertionError('Untrusted upload location accepted')
    assert len(calls)==2
assert 'private' not in output.getvalue()
location='/v2/vombor/kanban/blobs/upload/probe'
for cancel_status, expected in [(405,0),(403,1)]:
    calls.clear()
    output=io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output): result=module['main']()
    assert result==expected and len(calls)==3 and 'private' not in output.getvalue()
    if cancel_status==405:
        record=json.loads(output.getvalue().splitlines()[-1])
        assert record['uploadAuthorized'] is True and record['preflightUploadCancelled'] is False
        assert record['cancellationUnsupported'] is True
calls.clear()
def denied(req, timeout): raise urllib.error.HTTPError(req.full_url,403,'private-server-response',{},None)
urllib.request.urlopen=denied
output=io.StringIO()
with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output): result=module['main']()
assert result==1 and 'HTTP 403' in output.getvalue() and 'private' not in output.getvalue()
`;
		const result = spawnSync(
			"python3",
			["-c", script, resolve(__dirname, "../../.github/scripts/verify-ghcr-access.py")],
			{ encoding: "utf8" },
		);
		expect(result.status, result.stderr).toBe(0);
	});
});
