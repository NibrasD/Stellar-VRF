// Terraform example: AWS KMS (SIGN_VERIFY) + Secrets Manager
// NOTE: Example only — review and adapt for your org's policies.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "vrf_private_key_hex" {
  type = string
  description = "Hex-encoded secp256k1 VRF private key (sensitive)"
}

resource "aws_kms_key" "vrf_signing" {
  description               = "KMS key for VRF signing (secp256k1 / ECC_SECG_P256K1)"
  key_usage                 = "SIGN_VERIFY"
  // Some provider versions use `key_spec` or `customer_master_key_spec`.
  // Use the appropriate attribute for your terraform-aws-provider version.
  customer_master_key_spec  = "ECC_SECG_P256K1"
  deletion_window_in_days   = 7
  # Rotation is not supported for asymmetric KMS keys (e.g., ECC_SECG_P256K1).
  # Disable automatic key rotation for this asymmetric signing key.
  enable_key_rotation       = false
  tags = {
    Name    = "vrf-signing-key"
    Project = "Stellar-VRF"
  }
}

resource "aws_kms_alias" "vrf_alias" {
  name          = "alias/vrf-signing"
  target_key_id = aws_kms_key.vrf_signing.key_id
}

# Symmetric KMS key used to encrypt the Secrets Manager secret value.
resource "aws_kms_key" "vrf_encryption" {
  description             = "KMS symmetric key for Secrets Manager encryption (VRF secret)"
  key_usage               = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  deletion_window_in_days = 7
  enable_key_rotation     = true
  tags = {
    Name    = "vrf-encryption-key"
    Project = "Stellar-VRF"
  }
}

resource "aws_kms_alias" "vrf_encryption_alias" {
  name          = "alias/vrf-encryption"
  target_key_id = aws_kms_key.vrf_encryption.key_id
}

resource "aws_secretsmanager_secret" "vrf_private" {
  name        = "vrf/private/vrf_private_key_hex"
  description = "Hex-encoded secp256k1 VRF private key (used by api-server)."
  # Use a symmetric key for encryption; signing keys (SIGN_VERIFY) cannot be
  # used to generate data keys for Secrets Manager.
  kms_key_id  = aws_kms_key.vrf_encryption.key_id
  tags = {
    Project = "Stellar-VRF"
  }
}

resource "aws_secretsmanager_secret_version" "vrf_private_value" {
  secret_id     = aws_secretsmanager_secret.vrf_private.id
  secret_string = jsonencode({ vrf_private_key_hex = var.vrf_private_key_hex })
}

output "kms_key_id" {
  value = aws_kms_key.vrf_signing.key_id
}

output "secret_arn" {
  value = aws_secretsmanager_secret.vrf_private.arn
}
