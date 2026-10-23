terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  # This module is pure: it renders configuration values and exposes them as
  # outputs. No provider means `terraform validate` and the render checks need
  # no credentials and cannot produce drift.
  required_providers {}
}
