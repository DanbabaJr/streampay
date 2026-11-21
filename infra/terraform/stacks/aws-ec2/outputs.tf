output "instance_id" {
  description = "The EC2 instance the stack runs on."
  value       = aws_instance.stack.id
}

output "public_ip" {
  description = "Elastic IP. Point your tls_domain at this before applying with tls_mode=acme, or the first certificate request fails."
  value       = aws_eip.stack.public_ip
}

output "dashboard_url" {
  description = "What to open once it is up. With tls_mode=internal the certificate is Caddy's own CA: expect a browser warning you can pin away, not a broken listener."
  value = var.tls_mode == "off" ? "http://${aws_eip.stack.public_ip}/" : (
    var.tls_domain != "" ? "https://${var.tls_domain}/" : "https://${aws_eip.stack.public_ip}/"
  )
}

output "ssh_alternative" {
  description = "How to get a shell on the host."
  value = var.enable_session_manager ? join("\n", [
    "# No inbound port, authorized by your IAM identity. Needs the Session Manager plugin locally.",
    "aws ssm start-session --region ${var.region} --target ${aws_instance.stack.id}",
    ]) : join("\n", [
    "# Session Manager is off in this plan, so the only way in is ssh on an opened port 22.",
    "ssh -i your-key -L 3000:127.0.0.1:${var.grafana_host_port} ubuntu@${var.tls_domain != "" ? var.tls_domain : aws_eip.stack.public_ip}",
  ])
}

output "bundle_bucket" {
  description = "Where the rendered bundle lives. The bundle is config, not credentials: no secret value is ever uploaded here."
  value = {
    bucket = local.bucket
    prefix = var.bundle_prefix
    files  = sort([for o in aws_s3_object.bundle : o.key])
  }
}

output "bundle_sha256" {
  description = "Hash of the bundle the instance installs, also stored on the instance tag. Compare it with the tag to prove what is running."
  value       = module.vm.bundle_sha256
}

output "secrets" {
  description = "What has to exist in the secret source before fetch-secrets.sh on the host can succeed."
  value = {
    strategy        = module.secrets.strategy
    names           = module.secrets.secret_names
    ssm_arns        = local.ssm_parameter_arns
    ssm_path_prefix = local.ssm_path_prefix
    host_files      = module.vm.secret_paths_by_service
    threat_note     = try(module.secrets.threat_notes[var.secrets_strategy], "")
  }
}

output "iam" {
  description = "The role the host carries, and the exact surface it grants."
  value = {
    instance_profile = aws_iam_instance_profile.instance.name
    role             = aws_iam_role.instance.name
    grants = compact([
      "s3:GetObject on ${local.bucket}/${var.bundle_prefix}/*",
      "s3:ListBucket on ${local.bucket} (prefix condition)",
      var.secrets_strategy == "ssm" ? "ssm:GetParameter on ${length(local.ssm_parameter_arns)} named parameters" : "",
      var.enable_session_manager ? "AmazonSSMManagedInstanceCore (Session Manager channel only, no SSM parameter reads)" : "",
    ])
  }
}

output "systemd_units" {
  description = "Unit files install.sh wrote, including the extender timer when it is enabled."
  value       = module.vm.systemd_units
}

output "images" {
  description = "Image references the compose project resolves. With build_local=true these are tags built on the host from the checkout; otherwise they are pulled, and a :local tag will fail on a machine that never built it."
  value = {
    build_local = var.build_local
    images      = [for svc in module.services.all_services : svc.image]
  }
}

output "next_steps" {
  description = "From a created instance to an observing stack, in the order a human should run them."
  value = join("\n", [
    "# 1. cloud-init does the install; watch it",
    "aws ec2 describe-instance-status --region ${var.region} --instance-ids ${aws_instance.stack.id}",
    "aws ssm start-session --region ${var.region} --target ${aws_instance.stack.id}",
    "#    then on the host: tail -n 100 /var/log/streampay-install.log",
    "# 2. the stack converges itself; check the units",
    "systemctl status ${local.stack_unit}.service --no-pager",
    "systemctl list-timers 'streampay-*' --no-pager",
    "# 3. prove it observes the chain",
    "docker compose -f ${var.install_dir}/docker-compose.yml ps",
    "# 4. re-apply is empty when nothing changed",
    "terraform plan -detailed-exitcode",
  ])
}

output "destroy_notes" {
  description = "What a destroy leaves behind and what it takes with it, because the difference is the indexed ledger."
  value = join("\n", [
    "Destroying removes the instance, the security group, the EIP and (when this",
    "stack created it) the VPC and the bundle bucket. The data volume is removed",
    "too, and with it every ledger row the indexer wrote: take a snapshot first",
    "(`aws ec2 create-snapshot --volume-id ...`) if you might want the history.",
    "Nothing in this stack needs to survive: the ledger can always be rebuilt by",
    "re-indexing from the contract's start ledger, which is slow but complete.",
  ])
}
