#!/usr/bin/env python3
"""Apply exactly one textual mutation to a source file, or refuse.

A mutation that matches more than one site can land on the wrong one, run the
whole suite, and report a false green. That happened here: two identical lines
constructed the same rejection, the mutation hit the unreachable one, and the
survivor looked like a missing vector rather than dead code.

Usage: apply-mutation.py <file> <old> <new>
"""
import pathlib
import sys


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    path, old, new = pathlib.Path(argv[1]), argv[2], argv[3]
    source = path.read_text()
    found = source.count(old)
    if found != 1:
        print(f"{path}: the mutation matches {found} sites, not 1", file=sys.stderr)
        return 1
    if old == new:
        print(f"{path}: this mutation changes nothing", file=sys.stderr)
        return 1
    path.write_text(source.replace(old, new, 1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
