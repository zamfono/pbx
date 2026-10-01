# shellcheck shell=bash
# Sourced by the integration and load harnesses: the directory a test stack runs from, made the
# way an operator makes one (deploy/README.md): the files of deploy/, then the .env
# deploy/setup.sh writes from the answers in the caller's environment, without a terminal. The
# harness runs it as a Compose project of its own, so a stack a developer runs from deploy/ itself
# is never touched. Reads `repo`.

# deploy/'s files in directory `$1`, without the .env of a stack in deploy/ itself.
stack_dir_files() {
  tar -C "$repo/deploy" --exclude=./.env -cf - . | tar -C "$1" -xf -
}

# The .env setup.sh writes in stack directory `$1`, its output kept in `$1/setup.log`.
stack_dir_env() {
  SETUP_NONINTERACTIVE=1 bash "$1/setup.sh" >"$1/setup.log" 2>&1
}

# A Compose project name for stack directory `$1`: its name, lowercased, `.` turned into `-`.
stack_project() {
  basename "$1" | tr 'A-Z.' 'a-z-'
}
