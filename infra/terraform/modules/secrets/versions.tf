terraform {
  # Pure module: it emits *references* and fetch scripts, never secret values,
  # so it works with no provider and keeps nothing sensitive in state.
  required_version = ">= 1.6.0, < 2.0.0"
  required_providers {}
}
