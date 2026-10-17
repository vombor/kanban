import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const python = spawnSync("python3", ["--version"]);
describe.skipIf(python.error || python.status !== 0)("GHCR preflight", () => {
	it("accepts opaque tokens, checks and cancels a real upload handshake without exposing credentials", () => {
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
def request(req, timeout):
    calls.append(req)
    if len(calls)==1: return Response(200,b'{"token":"opaque-private-registry-token"}')
    if len(calls)==2: return Response(202,headers={'Location':'/v2/vombor/kanban/blobs/uploads/probe'})
    return Response(204)
urllib.request.urlopen=request
output=io.StringIO()
with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output): result=module['main']()
assert result==0
assert [r.get_method() for r in calls]==['GET','POST','DELETE']
assert calls[1].get_header('Authorization')=='Bearer opaque-private-registry-token'
assert 'private' not in output.getvalue()
assert json.loads(output.getvalue())['preflightUploadCancelled'] is True
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
