# Debian's /etc/profile replaces the image PATH before sourcing profile.d.
# Restore runtime tool directories only for the unprivileged container user.
if [ "$(id -un)" = "node" ]; then
  export PATH="/usr/local/go/bin:${PNPM_HOME:-/home/node/.local/share/pnpm}:${NPM_CONFIG_PREFIX:-/home/node/.npm-global}/bin:${GOPATH:-/home/node/go}/bin:${HOMEBREW_PREFIX:-/home/linuxbrew/.linuxbrew}/bin:${HOMEBREW_PREFIX:-/home/linuxbrew/.linuxbrew}/sbin:$PATH"
fi
