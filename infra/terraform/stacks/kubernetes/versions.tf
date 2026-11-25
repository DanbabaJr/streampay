terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  # Like the minimal path, this stack renders with no cloud credentials: the
  # kubernetes provider is deliberately absent. modules/k8s emits manifest
  # documents, so `terraform validate`, CI and a laptop run all work against a
  # cluster that does not exist yet, and the operator keeps the choice between
  # `kubectl apply -f`, Argo CD and whatever their platform team mandates.
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
