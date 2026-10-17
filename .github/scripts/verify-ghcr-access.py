"""Check the generated Actions token's exact GHCR repository scope without logging credentials."""
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def main():
    image = os.environ.get("IMAGE", "")
    if not image.startswith("ghcr.io/") or ":" in image or "@" in image:
        raise ValueError("IMAGE must be an untagged ghcr.io repository")
    repository = image.removeprefix("ghcr.io/")
    user = os.environ.get("GHCR_USER", "")
    token = os.environ.get("GHCR_TOKEN", "")
    if not user or not token:
        raise ValueError("Registry preflight needs the generated Actions token and actor")
    # Confirm the token and existing package resolve to the same immutable repository id, not a stale association.
    owner = repository.split("/", 1)[0]
    api_headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "kanban-registry-preflight"}
    for label, path in [("workflowRepository", "repos/" + repository), ("existingPackage", f"users/{owner}/packages/container/" + urllib.parse.quote(repository.split("/", 1)[1], safe=""))]:
        try:
            with urllib.request.urlopen(urllib.request.Request("https://api.github.com/" + path, headers=api_headers), timeout=30) as response:
                info = json.load(response)
            linked = info.get("repository", {}) if label == "existingPackage" else info
            print(json.dumps({"check": label, "repositoryId": linked.get("id"), "repository": linked.get("full_name"), "packageId": info.get("id") if label == "existingPackage" else None}))
        except urllib.error.HTTPError as error:
            print(json.dumps({"check": label, "httpStatus": error.code}))
    authorization = base64.b64encode(f"{user}:{token}".encode()).decode()
    query = urllib.parse.urlencode({"service": "ghcr.io", "scope": f"repository:{repository}:pull,push"})
    request = urllib.request.Request(
        "https://ghcr.io/token?" + query,
        headers={"Authorization": "Basic " + authorization, "User-Agent": "kanban-registry-preflight"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        # Response bodies may contain credentials in proxies; never print them or the request headers.
        print(f"::error::GHCR denied generated-token pull,push scope for {repository} (HTTP {error.code}). "
              "The workflow requests packages:write. Check exact package/repository Actions authorization; "
              "if it is already Admin with inheritance, this is a registry authorization failure, not a missing pod token. "
              "No PAT fallback is permitted.", file=sys.stderr)
        return 1
    scoped_token = data.get("token", "")
    if not isinstance(scoped_token, str) or not scoped_token:
        raise ValueError("Missing scoped registry token")
    # Registry tokens are opaque. Check a real empty upload handshake, then cancel it; never publish a tag or blob.
    headers = {"Authorization": "Bearer " + scoped_token, "User-Agent": "kanban-registry-preflight"}
    start = urllib.request.Request(f"https://ghcr.io/v2/{repository}/blobs/uploads/", data=b"", headers=headers, method="POST")
    stage = "start empty upload"
    try:
        with urllib.request.urlopen(start, timeout=30) as response:
            if response.status != 202:
                raise ValueError("Unexpected upload handshake")
            location = urllib.parse.urljoin("https://ghcr.io", response.headers.get("Location", ""))
        target = urllib.parse.urlparse(location)
        # GHCR returns singular `upload/`; the Distribution API commonly returns `uploads/`.
        upload_prefixes = (f"/v2/{repository}/blobs/upload/", f"/v2/{repository}/blobs/uploads/")
        if target.scheme != "https" or target.netloc != "ghcr.io" or target.fragment or not target.path.startswith(upload_prefixes):
            raise ValueError("Unexpected registry upload location")
        print(json.dumps({"registry": "ghcr.io", "repository": repository, "uploadAuthorized": True}))
        stage = "cancel empty upload"
        with urllib.request.urlopen(urllib.request.Request(location, headers=headers, method="DELETE"), timeout=30) as response:
            if response.status != 204:
                raise ValueError("Could not cancel preflight upload")
    except urllib.error.HTTPError as error:
        if stage == "cancel empty upload" and error.code == 405:
            # GHCR authorizes the POST but does not implement DELETE for its temporary upload URLs.
            # No bytes, blob or manifest were uploaded; do not mistake cleanup support for push authorization.
            print("::warning::GHCR authorized the empty upload but does not support cancelling it (HTTP 405); no blob or image was published.")
            print(json.dumps({"registry": "ghcr.io", "repository": repository, "uploadAuthorized": True, "preflightUploadCancelled": False, "cancellationUnsupported": True}))
            return 0
        print(f"::error::GHCR refused to {stage} for {repository} (HTTP {error.code}); "
              "no image/tag was published and no PAT fallback is permitted.", file=sys.stderr)
        return 1
    print(json.dumps({"registry": "ghcr.io", "repository": repository, "uploadAuthorized": True, "preflightUploadCancelled": True}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("::error::Registry preflight failed safely; token and raw response were not logged.", file=sys.stderr)
        sys.exit(1)
