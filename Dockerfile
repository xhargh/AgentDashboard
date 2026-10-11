FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /workspace

# This project requires Node >=22.16 and pins Playwright to 1.56.1.
RUN node -e "if (Number(process.versions.node.split('.')[0]) < 22 || (Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) < 16)) process.exit(1)" \
    && test "$(npm view @playwright/test@1.56.1 version)" = "1.56.1"

CMD ["sh", "-c", "npm ci && npm test && npm run check && npm run test:e2e"]
