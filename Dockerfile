
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

# Install the exact Nitron version used by Forge Studio.
RUN npm install -g nitron@3.1.5 --no-audit --no-fund

# Prepare Nitron's Android template and native plugin runtime.
RUN NITRON_ROOT="$(npm root -g)/nitron" && \
    echo "Preparing Nitron native plugin runtime..." && \
    test -f "$NITRON_ROOT/scripts/prepare-template.js" && \
    cd "$NITRON_ROOT" && \
    node scripts/prepare-template.js && \
    test -f "$NITRON_ROOT/template/nitron-plugin-api.jar" && \
    test -f "$NITRON_ROOT/template/base.apk" && \
    echo "Nitron template preparation verified."

# Confirm the required build tools exist.
RUN javac -version && nitron --version

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
