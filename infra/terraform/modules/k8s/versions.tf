terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  # Pure module: it renders manifest documents and never talks to a cluster, so
  # `terraform validate` and CI work without kubeconfig or credentials. The stack
  # that consumes it decides how the rendered YAML is applied.
  required_providers {}
}
