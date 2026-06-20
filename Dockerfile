FROM node:20-slim

# Set working directory
WORKDIR /app

# Install system dependencies for Puppeteer & Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to skip installing its own Chromium and use the system one
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

# Install pnpm globally
RUN npm install -g pnpm@11.4.0

# Copy package files for workspace install caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/

# Install dependencies (development dependencies are required for building)
RUN pnpm install --frozen-lockfile

# Copy the rest of the workspace source code
COPY . .

# Build both frontend and backend projects
RUN pnpm build

# Expose backend server port
EXPOSE 4001

# Start the unified backend server
CMD ["pnpm", "--filter", "backend", "start"]
