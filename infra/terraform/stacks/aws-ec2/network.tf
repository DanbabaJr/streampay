# Network: created when vpc_id is empty, otherwise your existing VPC is used
# untouched. One public subnet, because this is a single-VM story and a second AZ
# without an ALB or ASG only doubles the number of things that can be misconfigured.

resource "aws_vpc" "stack" {
  count = local.create_network ? 1 : 0

  cidr_block           = "10.32.0.0/20"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.name}-vpc" }
}

resource "aws_internet_gateway" "stack" {
  count = local.create_network ? 1 : 0

  vpc_id = aws_vpc.stack[0].id

  tags = { Name = "${var.name}-igw" }
}

resource "aws_subnet" "public" {
  count = local.create_network ? 1 : 0

  vpc_id                  = aws_vpc.stack[0].id
  cidr_block              = "10.32.0.0/22"
  availability_zone       = local.az
  map_public_ip_on_launch = false

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table" "public" {
  count = local.create_network ? 1 : 0

  vpc_id = aws_vpc.stack[0].id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.stack[0].id
  }

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  count = local.create_network ? 1 : 0

  subnet_id      = aws_subnet.public[0].id
  route_table_id = aws_route_table.public[0].id
}

locals {
  vpc_id    = local.create_network ? aws_vpc.stack[0].id : var.vpc_id
  subnet_id = local.create_network ? aws_subnet.public[0].id : var.subnet_id

  # Mirroring 0.0.0.0/0 to ::/0 is deliberate: a restricted list (an office VPN)
  # gets no IPv6 rule at all, rather than an accidental worldwide opening.
  public_ipv6_cidrs = contains(var.allowed_https_cidrs, "0.0.0.0/0") ? ["::/0"] : []

  listener_ports = concat(
    length(var.allowed_https_cidrs) > 0 ? [80, 443] : [],
    length(var.allowed_ssh_cidrs) > 0 ? [22] : []
  )

  # 80 is open alongside 443 even though the dashboard is on 443: the ACME
  # http-01 challenge arrives from Let's Encrypt's servers, and Caddy answers 80
  # with a redirect.
  ingress_rules = [
    for port in local.listener_ports : {
      port        = port
      description = port == 22 ? "ssh" : (port == 80 ? "acme-challenge-and-redirect" : "public listener")
      cidr_blocks = port == 22 ? var.allowed_ssh_cidrs : var.allowed_https_cidrs
      ipv6        = port == 22 ? [] : local.public_ipv6_cidrs
    }
  ]
}

resource "aws_security_group" "stack" {
  name        = "${var.name}-stack"
  description = "StreamPay stack: public listener in, everything else via loopback or SSM"
  vpc_id      = local.vpc_id

  dynamic "ingress" {
    for_each = local.ingress_rules

    content {
      description      = ingress.value.description
      from_port        = ingress.value.port
      to_port          = ingress.value.port
      protocol         = "tcp"
      cidr_blocks      = ingress.value.cidr_blocks
      ipv6_cidr_blocks = ingress.value.ipv6
    }
  }

  # Outbound is open because every one of these services calls a public Stellar
  # RPC/Horizon endpoint whose address you do not control, and because the ACME
  # order, the image pulls and the SSM reads all leave from here.
  egress {
    description = "stellar rpc, horizon, registries, acme, ssm"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name}-stack" }
}
