FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=3000

RUN apt-get update && \
    apt-get install -y --no-install-recommends openjdk-17-jdk-headless curl ca-certificates unzip zip && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Nitron is the Android packaging engine used by the build worker.
RUN npm install -g nitron@3.1.5 --no-audit --no-fund

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
