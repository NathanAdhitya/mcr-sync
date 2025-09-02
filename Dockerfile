# Use the official Bun slim image as a lightweight base
FROM oven/bun:1-slim

# Set the working directory inside the container
WORKDIR /app

# Copy dependency definition files
# By copying these first, we leverage Docker's layer caching.
# The 'bun install' step will only re-run if these files change.
COPY package.json bun.lockb tsconfig.json ./

# Install dependencies. Using --frozen-lockfile is best practice for CI/CD and Docker
# to ensure reproducible builds.
RUN bun install --frozen-lockfile

# Copy the rest of the application source code and the default config
COPY src ./src

# This command will be executed when the container starts
CMD ["bun", "start"]

