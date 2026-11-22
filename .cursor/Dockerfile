# Cursor Cloud Agent custom environment for MarkText -> MarkText-GPUI migration.
# Follows Cursor Cloud Agent guidelines:
# - Non-root `ubuntu` user with `/home/ubuntu` working directory
# - Does NOT COPY repository files (Cursor clones the repository at runtime)
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install system build toolchain, Linux GPUI/Wayland/X11/Vulkan dependencies, and Node.js 22 + pnpm 10
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    gnupg \
    ca-certificates \
    build-essential \
    pkg-config \
    libssl-dev \
    libxkbcommon-dev \
    libwayland-dev \
    libxcb1-dev \
    libfontconfig1-dev \
    libvulkan-dev \
    mesa-vulkan-drivers \
    libasound2-dev \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && corepack enable \
    && corepack prepare pnpm@10 --activate \
    && rm -rf /var/lib/apt/lists/*

USER ubuntu
WORKDIR /home/ubuntu

# Install Rust stable toolchain (rustc, cargo, clippy, rustfmt) as ubuntu user
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --component clippy,rustfmt

ENV PATH="/home/ubuntu/.cargo/bin:${PATH}"

# Verify toolchains are available on PATH
RUN node --version && pnpm --version && rustc --version && cargo --version
