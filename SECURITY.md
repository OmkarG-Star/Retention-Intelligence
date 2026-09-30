# Security Policy

## Public-repository scope

This repository is a portfolio/demo application and contains **synthetic workforce data only**. It must not be populated with real employee records while the repository is public.

## Never commit

- `.env` files
- API keys, OAuth tokens or session secrets
- production databases
- real employee records
- resumes or other HR documents
- internal company reports
- private infrastructure URLs or credentials
- cloud access keys

## Deployment requirements

For any non-local deployment:

1. Generate a strong random `SECRET_KEY`.
2. Replace the seeded demo credentials.
3. Store secrets in environment variables or a secret manager.
4. Enable HTTPS/TLS.
5. Restrict database/network access.
6. Configure appropriate CORS and reverse-proxy rules.
7. Keep real HR datasets outside the public repository.
8. Review role permissions before granting HR users access.
9. Keep audit logs protected from unauthorized modification.
10. Perform a privacy, security and legal review before processing real employee data.

## AI / Copilot security

The Copilot should only receive data that the authenticated user is authorized to access. Real deployments should add explicit data minimization, prompt-injection defenses, tool allowlists, model/provider controls and audit logging around AI actions.

The AI layer must not be treated as an autonomous decision-maker for hiring, termination, compensation, promotion or other consequential employment decisions.

## Reporting a vulnerability

For a public portfolio repository, do not post sensitive security findings or exposed credentials in a public issue. Use the repository owner's private security-reporting channel when one is configured.
