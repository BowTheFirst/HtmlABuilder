FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install Java 17 and Node.js 18
RUN apt-get update && \
    apt-get install -y openjdk-17-jdk-headless curl && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install Nitron globally so it's available everywhere
RUN npm install -g nitron

WORKDIR /app

# Copy package files and install app dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the app
COPY . .

# Start the server
CMD ["node", "index.js"]d $ANDROID_HOME/cmdline-tools && \
    mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest && \
    rm sdk.zip && \
    yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses && \
    $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-33" "build-tools;33.0.1"

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# THIS IS THE UPDATED LINE:
CMD ["node", "index.js"]e-tools/latest/bin/sdkmanager --licenses && \
    $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-33" "build-tools;33.0.1"

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the app
COPY . .

# Start the server
CMD ["node", "server.js"]