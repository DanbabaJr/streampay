terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
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

# Region comes from a variable rather than the provider's own chain so that the
# SSM ARNs, the AMI lookup and the EIP all agree with each other even when
# AWS_REGION is set in the shell for some unrelated profile.
provider "aws" {
  region = var.region

  # Nothing here is a secret: the instance profile is the credential path, and
  # the plan is reviewable without one.
}
