FROM ubuntu:22.04

# LANG/LC_ALL matter: ubuntu:22.04 ships no locale, so the JVM falls back to
# US-ASCII. Nitron's MainActivity.java has UTF-8 box-drawing characters in its
# comments, and scripts/prepare-template.js calls javac without -encoding,
# which fails with hundreds of "unmappable character" errors. See BUILD-FIX.md.
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=3000 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64

# Install Java 17 JDK and system utilities.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        openjdk-17-jdk-headless \
        curl \
        ca-certificates \
        git \
        unzip \
        zip && \
    rm -rf /var/lib/apt/lists/*

# Install Node.js 20.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Build Nitron from a pinned plugin-capable source revision.
# Native plugins were added in 3.2.0; npm still publishes 3.1.5, which
# silently ignores the plugin configuration and produces APKs without DEX.
ARG NITRON_COMMIT=d20713023d84880ab9b26f44e0e57f919917cb6c
RUN git clone https://github.com/ALightbolt4G/nitron.git /opt/nitron && \
    cd /opt/nitron && \
    git checkout --detach "${NITRON_COMMIT}" && \
    test "$(node -p "require('./package.json').version")" = "3.2.0" && \
    test -s template/base.apk && \
    test -s template/nitron-plugin-api.jar

# Keep dependency installation and CLI compilation in separate layers so a
# failed command is visible in the Docker build output.
RUN cd /opt/nitron && npm ci --include=dev --no-audit --no-fund

# Bring in ONLY the patch scripts first. All patches must be applied before
# anything is compiled: the icon patch edits TypeScript that tsup bundles into
# dist/, while the theme and system-bars patches edit Java that prepare-template.js
# dexes. Patching after compilation would silently ship an unpatched shell.
COPY scripts/ /opt/forge-scripts/

RUN test -f /opt/forge-scripts/patch-nitron-theme.js && \
    test -f /opt/forge-scripts/patch-nitron-icon.js && \
    test -f /opt/forge-scripts/patch-nitron-system-bars.js && \
    test -f /opt/forge-scripts/patch-nitron-runtime-config.js && \
    test -f /opt/forge-scripts/verify-icon-align.js

# Make the template compiler locale-independent. prepare-template.js builds its
# javac command without -encoding, so it inherits the platform charset. Pinning
# UTF-8 here means the build no longer depends on LANG being set correctly.
RUN cd /opt/nitron && node -e "const fs=require('fs');const f='scripts/prepare-template.js';let s=fs.readFileSync(f,'utf8');const a=\"const javacBase = ['-Xlint:-options',\";if(!s.includes(a))throw new Error('prepare-template.js: javacBase anchor not found; refusing to build with an unknown charset');if(!s.includes(\"'-encoding', 'UTF-8'\")){s=s.replace(a,\"const javacBase = ['-encoding', 'UTF-8', '-Xlint:-options',\");fs.writeFileSync(f,s);console.log('prepare-template.js: pinned javac -encoding UTF-8');}"

# Real system night-mode support: WebView derives prefers-color-scheme from the
# Activity theme's isLightTheme.
RUN node /opt/forge-scripts/patch-nitron-theme.js /opt/nitron/template-src/base/MainActivity.java

# Native immersive mode: expose a trusted WebView bridge backed by MainActivity
# itself, then re-apply the selected state whenever the Activity resumes/focuses.
RUN node /opt/forge-scripts/patch-nitron-system-bars.js /opt/nitron/template-src/base/MainActivity.java

# ── LIVE-URL FIX ─────────────────────────────────────────────────────────────
# Nitron emits every nitron.* <meta-data> INSIDE <activity>, but MainActivity
# reads ApplicationInfo.metaData, which only exposes <application>-level
# meta-data. The bundle is therefore null and EVERY runtime setting silently
# falls back to its default — including externalLinks, which stays "browser".
# That is why a live-URL app never leaves the local "Opening website…" page:
# shouldOverrideUrlLoading() hands the redirect to the system browser.
#
# This patches both sides (manifest emitter + Java reader), so it MUST run
# before `npm run build` (TypeScript) and before prepare-template.js (Java).
RUN node /opt/forge-scripts/patch-nitron-runtime-config.js /opt/nitron

# Adaptive-icon quality: keep legacy icons at 48dp but generate adaptive
# foregrounds at the full 108dp Android layer size for every density bucket.
# This prevents high-density launchers from upscaling undersized foregrounds.
RUN node /opt/forge-scripts/patch-nitron-icon.js /opt/nitron/src/engines/nitronoid/aapt2-resource-builder.ts

RUN cd /opt/nitron && \
    npm run build && \
    npm link && \
    test "$(nitron --version)" = "3.2.0" && \
    grep -q forgeAdaptiveSize dist/cli.js && \
    grep -q FORGE_RUNTIME_METADATA_PATCH dist/cli.js

# Build the patched native shell. This also downloads android.jar (~65MB) and R8
# (~16MB) into ~/.nitron/android in a layer that only invalidates when Nitron or
# the patches change, so editing Forge Studio no longer re-downloads 82MB or
# recompiles Java on every deploy.
RUN cd /opt/nitron && node scripts/prepare-template.js && \
    test -s template/base.apk && \
    test -s template/nitron-plugin-api.jar

# A non-empty base.apk is not proof the patches landed: assert the DEX contains
# the night-theme code, the native system-bar bridge, and the runtime-config
# reader. This prevents shipping a server image whose generated APKs silently
# ignore those settings.
RUN cd /opt/nitron && node -e "const z=require('adm-zip');const d=new z('template/base.apk').getEntry('classes.dex');if(!d)throw new Error('base.apk has no classes.dex');const s=d.getData().toString('latin1');for(const m of ['dark light','forgeLastNightMode','onConfigurationChanged','setSystemBarsVisible','forgeRuntimeMetaData','getActivityInfo'])if(!s.includes(m))throw new Error('native template patch missing from rebuilt classes.dex: '+m);console.log('OK: classes.dex contains Forge night-theme, native system-bars and runtime-config patches');"

# Verify Java and Nitron independently.
RUN echo "========== JAVA CHECK ==========" && \
    echo "JAVA_HOME=$JAVA_HOME" && \
    echo "LANG=$LANG" && \
    command -v java || true

RUN echo "========== JAVAC CHECK ==========" && \
    command -v javac || true

RUN echo "========== NITRON CHECK ==========" && \
    command -v nitron || true

RUN echo "========== INSTALLED VERSIONS ==========" && \
    java -version && \
    javac -version && \
    npm --version && \
    node --version

# Verify Nitron's installation location.
RUN echo "========== NITRON GLOBAL PACKAGES ==========" && \
    npm list -g --depth=0 && \
    npm root -g

# Set up Forge Studio.
WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# The preview/export geometry contract. Cheap, no browser needed, and it fails
# the build if the crop preview ever drifts from the 512px export again.
RUN node /app/scripts/verify-icon-align.js

EXPOSE 3000

CMD ["node", "index.js"]
