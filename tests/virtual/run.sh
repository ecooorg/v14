#!/usr/bin/env bash
# Virtual tests: the real server.ts against a fake Gemini. No API key, no internet.
set -e
cd "$(dirname "$0")/../.."
tsx tests/virtual/server.test.mjs
tsx tests/virtual/infra.test.mjs
tsx tests/virtual/v17.test.mjs
tsx tests/virtual/regression.test.mjs
tsx tests/virtual/perf.test.mjs
tsx tests/virtual/files.test.mjs
tsx tests/virtual/expert-files.test.mjs
tsx tests/virtual/stage2.test.mjs
