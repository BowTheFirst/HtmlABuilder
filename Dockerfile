
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=3000

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openjdk-17-jdk-headless \
    curl ca-certificates unzip zip && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Native plugin support requires Nitron 3.2.0 or newer.
RUN npm install -g nitron@3.2.0 --no-audit --no-fund

# Verify the installed build tools.
RUN javac -version && nitron --version

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
