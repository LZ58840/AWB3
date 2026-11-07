# Python tests of the offline tools. The venv (tools/.venv, gitignored) is not an input. The tests run
# with the interpreter of the venv by its path. This probe hashes the Python version and the installed
# packages in its place (not cached on purpose). It needs the heph home at <repo>/.heph (the default).
target(
    name = "venv",
    driver = "bash",
    runtime_pass_env = ["PATH"],
    cache = False,
    run = [
        'V="${WORKSPACE_ROOT%%/.heph/sandbox/*}/tools/.venv"',
        '[ -f "$V/pyvenv.cfg" ] || { echo "missing $V: python3 -m venv tools/.venv && tools/.venv/bin/pip install -r tools/requirements.txt" >&2; exit 1; }',
        'grep "^version" "$V/pyvenv.cfg" > $OUT',
        "find \"$V/lib\" -maxdepth 3 -name '*.dist-info' | sed 's|.*/||' | sort >> $OUT",
    ],
    out = "venv.txt",
)

# A test that reads a file outside tools/ needs that file listed here (abs = True counts from the repo root).
target(
    name = "pytest",
    driver = "bash",
    labels = ["test", "ci"],
    deps = [
        glob("*.py"),
        glob("tests/**", exclude = ["**/__pycache__/**"]),
        file("test/fixtures/backfill-sample.txt", abs = True),
    ],
    hash_deps = [":venv"],
    runtime_pass_env = ["PATH"],
    run = [
        'V="${WORKSPACE_ROOT%%/.heph/sandbox/*}/tools/.venv"',
        '"$V"/bin/python -I -B -m pytest tests -q -p no:cacheprovider | tee pytest.log',
        "grep -oE '[0-9]+ (passed|failed)' pytest.log > $OUT || true",
    ],
    out = "pytest.txt",
)
