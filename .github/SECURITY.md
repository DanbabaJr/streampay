# Security Policy

## Bounty Tiers

| Tier | Description | Reward Percentage |
|------|-------------|-------------------|
| 1    | Low Risk    | 5%                |
| 2    | Medium Risk | 10%               |
| 3    | High Risk   | 20%               |

## Scope

The following components are in scope for the bug bounty program:
- Smart Contracts
- Frontend Application
- CI/CD Pipeline

## Intake Form Validation

Please ensure that your report includes the following:
- What happened? (Include transaction hash / test name and expected vs actual behavior)
- Component (Select from contract, frontend, CI, docs)
- Reproduction steps (e.g., cargo test -p streampay-contract test::withdraw_...)
- Commit / version

## Triage SLA Bot

The triage bot will automatically assign, label, and ping the relevant team members based on the report's content. Ensure that the report is clear and follows the intake form guidelines.

## Postmortem Template

After resolving a reported issue, please fill out the following template:
- **Issue Title:**
- **Date Resolved:**
- **Summary of the Issue:**
- **Root Cause:**
- **Resolution Steps:**
- **Lessons Learned:**

Thank you for contributing to the security of our project!