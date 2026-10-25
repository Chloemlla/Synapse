import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// CI only. The isolated Python oracle checks the independently implemented Node wire algorithm.
const oracle = String.raw`
"""CI-only interoperability oracle; never execute downloaded code from its directory."""
import ast
import functools
import json
import pathlib
import struct
import subprocess
import sys
import tempfile
import typing
import urllib.request

REVISION = "ba61d94442c18893f0c4d3c5ad253718b21ab93e"
URL = f"https://raw.githubusercontent.com/rany2/edge-tts/{REVISION}/src/edge_tts/drm.py"
# The pinned LGPLv3 reference is temporary test input, not shipped application code.
with tempfile.TemporaryDirectory(prefix="edge-gec-reference-") as directory:
    target = pathlib.Path(directory) / "reference.py"
    with urllib.request.urlopen(URL, timeout=30) as response:
        target.write_bytes(response.read(128 * 1024))
    module = ast.parse(target.read_text(encoding="utf-8"))
    nodes = [node for node in module.body if isinstance(node, (ast.Assign, ast.FunctionDef))]
    scope = {**vars(typing), "struct": struct, "lru_cache": functools.lru_cache,
             "TRUSTED_CLIENT_TOKEN": "6A5AA1D4EAFF4E9FB37E23D68491D6F4"}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(target), "exec"), scope)
    vectors = [[1758796800000, 0], [1758796891000, 0], [1758797100000, 0],
               [1758796800000, 300], [1758796800000, -90000], [1792846686123, -1]]
    path = str(pathlib.Path(sys.argv[1]).resolve())
    program = "const f=require(process.argv[1]).generateEdgeSecMsGec;const v=JSON.parse(process.argv[2]);console.log(JSON.stringify(v.map(([t,s])=>f(t,s))));"
    result = subprocess.run(["node", "-e", program, path, json.dumps(vectors)],
                            check=True, capture_output=True, text=True, timeout=30)
    actual = json.loads(result.stdout)
    for (millis, skew), token in zip(vectors, actual, strict=True):
        expected = scope["generate_sec_ms_gec_v2"](millis / 1000 + skew)
        if token != expected:
            raise AssertionError(f"v2 token mismatch at {millis}/{skew}: {token} != {expected}")
        print(f"Edge v2 fixture {millis}/{skew}: {expected}")
    print(f"Edge v2 reference: {len(vectors)} exact fixtures match {REVISION}")
`;
process.stdout.write(execFileSync("python3", ["-I", "-c", oracle, resolve(process.argv[2])], {
  encoding: "utf8", timeout: 90000, maxBuffer: 1024 * 1024,
}));
