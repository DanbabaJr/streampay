terraform {
  # `local` writes the rendered bundle; `null` runs the bootstrap on a machine
  # that is already the target. Both are content-addressed, so a second apply
  # plans empty. No cloud provider is required for the minimal path.
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}
