<#
provision_kms.ps1 — PowerShell helper to run Terraform for KMS + Secrets
Usage:
  $env:VRF_PRIVATE_KEY_HEX = '<hex>'
  ./provision_kms.ps1 [-AutoApprove]
#>

param(
  [switch]$AutoApprove
)

if (-not (Get-Command terraform -ErrorAction SilentlyContinue)) {
  Write-Error "terraform not found in PATH. Install Terraform first."
  exit 2
}

if (-not $env:VRF_PRIVATE_KEY_HEX) {
  $env:VRF_PRIVATE_KEY_HEX = Read-Host -AsSecureString "Enter VRF private key hex" | ConvertFrom-SecureString -AsPlainText
}

if (-not $env:VRF_PRIVATE_KEY_HEX) {
  Write-Error "VRF_PRIVATE_KEY_HEX is required"
  exit 2
}

Push-Location (Split-Path -Path $MyInvocation.MyCommand.Definition -Parent)

Write-Output "Initializing Terraform..."
terraform init -input=false

Write-Output "Validating configuration..."
terraform validate

Write-Output "Planning (sensitive value set in TF_VAR_vrf_private_key_hex)..."
# set TF_VAR env var so the secret is not passed on the command line
$env:TF_VAR_vrf_private_key_hex = $env:VRF_PRIVATE_KEY_HEX

terraform plan -out=tfplan -input=false

if ($AutoApprove) {
  terraform apply -input=false -auto-approve tfplan
} else {
  terraform apply -input=false tfplan
}

Write-Output "Provisioning complete. Terraform outputs:"
terraform output

# cleanup sensitive env var
Remove-Item Env:TF_VAR_vrf_private_key_hex -ErrorAction SilentlyContinue

Pop-Location
