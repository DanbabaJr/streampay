terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  # The minimal path deliberately has no cloud provider: it renders and applies
  # with credentials that do not exist, on the machine that is about to run the
  # stack. That is what lets CI prove the single-VM story on every pull request.
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
