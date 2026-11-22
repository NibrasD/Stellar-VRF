#!/usr/bin/env python3
"""Fail if a Soroban contract WASM can replace its own code.

A Soroban contract's code can change only if the contract itself calls the
host function `update_current_contract_wasm` (module "l", function "6" in
soroban-env-common's env.json). This script reads the WASM import section and
fails if that import is present, or if any exported function name contains
"upgrade". Usage: check_immutable_wasm.py <contract.wasm>
"""
import sys

FORBIDDEN_IMPORT = ("l", "6")  # update_current_contract_wasm


def leb(buf, i):
    result = shift = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, i
        shift += 7


def name(buf, i):
    n, i = leb(buf, i)
    return buf[i : i + n].decode(), i + n


def sections(buf):
    if buf[:4] != b"\0asm":
        sys.exit("not a WASM file")
    i = 8
    while i < len(buf):
        sid = buf[i]
        size, j = leb(buf, i + 1)
        yield sid, buf[j : j + size]
        i = j + size


def imports(sec):
    count, i = leb(sec, 0)
    out = []
    for _ in range(count):
        mod, i = name(sec, i)
        fld, i = name(sec, i)
        kind = sec[i]
        i += 1
        if kind == 0:  # function: type index
            _, i = leb(sec, i)
        elif kind == 1:  # table: reftype + limits
            i += 1
            flag = sec[i]
            i += 1
            _, i = leb(sec, i)
            if flag & 1:
                _, i = leb(sec, i)
        elif kind == 2:  # memory: limits
            flag = sec[i]
            i += 1
            _, i = leb(sec, i)
            if flag & 1:
                _, i = leb(sec, i)
        elif kind == 3:  # global: valtype + mutability
            i += 2
        else:
            sys.exit(f"unknown import kind {kind}")
        out.append((mod, fld, kind))
    return out


def exports(sec):
    count, i = leb(sec, 0)
    out = []
    for _ in range(count):
        n, i = name(sec, i)
        i += 1  # kind
        _, i = leb(sec, i)
        out.append(n)
    return out


def main():
    buf = open(sys.argv[1], "rb").read()
    imps, exps = [], []
    for sid, sec in sections(buf):
        if sid == 2:
            imps = imports(sec)
        elif sid == 7:
            exps = exports(sec)
    bad = [f"{m}.{f}" for m, f, k in imps if k == 0 and (m, f) == FORBIDDEN_IMPORT]
    bad += [e for e in exps if "upgrade" in e.lower()]
    if bad:
        sys.exit(f"FAIL: contract can change its code: {bad}")
    print(f"OK: immutable ({len(imps)} imports, {len(exps)} exports, no update_current_contract_wasm)")


if __name__ == "__main__":
    main()
