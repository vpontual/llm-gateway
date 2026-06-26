# Contributing to LLM Gateway

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

1. Fork and clone the repo
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy and configure environment:
   ```bash
   cp .env.example .env
   # Edit .env with your Ollama server addresses
   ```
4. Start the database:
   ```bash
   docker compose up db -d
   ```
5. Run migrations:
   ```bash
   npm run db:migrate
   ```
6. Start the dev server:
   ```bash
   npm run dev
   ```

### Working on the Proxy

If your changes involve request routing, load balancing, or the proxy server, you'll also need the proxy running:

```bash
# Build and start the proxy (separate terminal)
npm run build:proxy
npm run proxy
```

The dashboard runs on port 3000 and the proxy on port 11434. For UI-only changes, you only need `npm run dev`.

## Running Tests

```bash
# Run all checks (lint + typecheck + unit tests)
npm run check

# Individual commands
npm run lint
npm run typecheck
npm test
```

Pre-commit hooks run `npm run check` automatically. They're installed when you run `npm install`.

## Submitting Changes

1. Create a feature branch from `main`
2. Make your changes
3. Ensure `npm run check` passes
4. Commit with a clear, descriptive message
5. Open a pull request against `main`

## Pull Request Guidelines

- Keep PRs focused: one feature or fix per PR
- Include a description of what changed and why
- Add tests for new functionality
- Update documentation if needed

## Code Style

- TypeScript strict mode is enforced
- ESLint is configured. Run `npm run lint` to check
- Follow existing patterns in the codebase

## Reporting Bugs

Use the [bug report template](https://github.com/vpontual/llm-traffic-manager/issues/new?template=bug_report.md) when filing issues. Include steps to reproduce, expected behavior, and your environment details.

## Security Issues

For security vulnerabilities, follow the [Security Policy](SECURITY.md) and report privately.

## Feature Requests

Use the [feature request template](https://github.com/vpontual/llm-traffic-manager/issues/new?template=feature_request.md) to propose new features.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
