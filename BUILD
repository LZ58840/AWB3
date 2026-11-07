# Cached local checks. A target does not run again when its inputs did not change.
#   heph run ci //...              typecheck and all tests (run this before a push)
#   heph run test //...            tests only
#   heph run //:test_image --raw   one target, with the output of the tool
# Run `npm ci` first. For the edit-and-test loop, keep `npm run test:watch`.
#
# node_modules is not an input. It has 27k files, and a copy into a sandbox takes about 3 s per run.
# Each node target links the installed tree into its sandbox instead. This needs the heph home at
# <repo>/.heph (the default). The target hashes the two lock files below in place of node_modules,
# because npm rewrites node_modules/.package-lock.json at each install. A manual edit inside
# node_modules is not seen.
#
# A test can read only the files that its target lists. In the sandbox, a file that is not listed gives
# ENOENT or "Failed to resolve import". Add that file to the target that failed.

# The node binary of the host is not hashed. This probe hashes its version (not cached on purpose).
target(
    name = "toolchain",
    driver = "bash",
    runtime_pass_env = ["PATH"],
    cache = False,
    run = "node --version > $OUT",
    out = "toolchain.txt",
)

LOCKS = [file("package-lock.json"), file("node_modules/.package-lock.json"), ":toolchain"]
CFG = [file("package.json"), file("tsconfig.json"), file("vitest.config.ts")]
LINK = 'R="${WORKSPACE_ROOT%%/.heph/sandbox/*}/node_modules"; mkdir node_modules; ln -s "$R"/* "$R"/.bin node_modules/'
PRIVATE = "test/fixtures/private/**"  # local only, gitignored

def vitest(name, tests, srcs, flags = ""):
    target(
        name = name,
        driver = "bash",
        labels = ["test", "ci"],
        deps = CFG + tests + srcs,
        hash_deps = LOCKS,
        env = {"NO_COLOR": "1"},
        runtime_pass_env = ["PATH"],
        run = [
            LINK,
            # The sandbox has no CI variable, so vitest would accept .only. That skips tests and still passes.
            "node_modules/.bin/vitest run --no-allowOnly " + flags + " | tee vitest.log",
            "grep -E '^ +(Test Files|Tests) ' vitest.log | sed 's/^ *//' > $OUT || true",
        ],
        out = name + ".txt",
    )

vitest(
    "test_core",
    tests = [glob("test/core/**"), glob("test/fixtures/*")],
    srcs = [glob("src/core/**")],
)

# CPU heavy. It is a separate target, so a change in the rules does not run it again.
vitest(
    "test_image",
    tests = [glob("test/image/**"), glob("test/fixtures/images/**"), file("test/fixtures/phash-vectors.json")],
    srcs = [glob("src/core/image/**")],
)

# Catch-all. Every other test directory (sim, flows, props, replay, ...) runs here without a BUILD edit.
# A property test uses a new random seed at each run, but a cached pass keeps an old one.
# Pin the seed, or run these tests with --force.
vitest(
    "test_rest",
    # The flow tests compare their comments with the legacy texts of test/core.
    tests = [glob("test/**", exclude = ["test/core/**", "test/image/**", "test/spike/**", "test/spikes/**", "test/calibration/**", PRIVATE]), glob("tools/red-first.*"), glob("tools/calibrate.*"), glob("tools/legacy_settings.*"), file("test/core/appendix.ts"), file("test/core/legacyText.ts")],
    srcs = [glob("src/**"), glob("devvit.json")],
    flags = "--passWithNoTests",
)

# The S2/S3 playtest app (spikes/s2s3) and its tests.
vitest(
    "test_spikes",
    tests = [glob("test/spikes/**")],
    srcs = [glob("spikes/**", exclude = ["spikes/**/dist/**", "spikes/**/spike-logs*", "spikes/**/spike-images/**"])],
    flags = "test/spikes",
)

target(
    name = "typecheck",
    driver = "bash",
    labels = ["ci"],
    deps = CFG + [
        glob("src/**"),
        glob("test/**/*.ts", exclude = [PRIVATE]),
        glob("test/**/*.json", exclude = [PRIVATE]),
        glob("tools/**/*.ts", exclude = ["tools/.venv/**"]),
        glob("devvit.json"),
        glob("spikes/**/*.ts", exclude = ["spikes/**/dist/**"]),
        glob("spikes/**/*.json", exclude = ["spikes/**/dist/**"]),
        glob("spikes/**/*.mjs"),
    ],
    hash_deps = LOCKS,
    runtime_pass_env = ["PATH"],
    run = [LINK, "node_modules/.bin/tsc --noEmit", "echo ok > $OUT"],
    out = "typecheck.txt",
)
