{
  description = "cfmon development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    moonbit-overlay = {
      url = "github:moonbit-community/moonbit-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs@{ self, flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];

      perSystem = { pkgs, system, ... }: {
        _module.args.pkgs = import inputs.nixpkgs {
          inherit system;
          overlays = [ inputs.moonbit-overlay.overlays.default ];
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.moonbit-bin.latest
            pkgs.nodejs
            pkgs.curl
            pkgs.openssl
            pkgs.pkg-config
          ];
        };

        apps.default = {
          type = "app";
          program = "${pkgs.writeShellApplication {
            name = "cfmon";
            runtimeInputs = [ pkgs.coreutils pkgs.nodejs ];
            text = ''
              umask 077
              if (( $# == 0 )); then
                echo "Usage: nix run github:OJII3/cfmon -- {setup|deploy} [--dry-run]" >&2
                exit 2
              fi

              action=$1
              shift
              case "$action" in
                setup) args=(--setup "$@") ;;
                deploy) args=("$@") ;;
                *)
                  echo "Unknown command: $action" >&2
                  echo "Usage: nix run github:OJII3/cfmon -- {setup|deploy} [--dry-run]" >&2
                  exit 2
                  ;;
              esac

              runtime_dir=$(mktemp -d "''${TMPDIR:-/tmp}/cfmon.XXXXXX")
              config_dir="''${XDG_CONFIG_HOME:-$HOME/.config}/cfmon"
              mkdir -p "$runtime_dir" "$config_dir"
              cp -R "${self}/." "$runtime_dir/"
              if [[ -f "$config_dir/worker.env" ]]; then
                cp "$config_dir/worker.env" "$runtime_dir/worker/.env"
              fi
              if [[ -f "$config_dir/deployment.json" ]]; then
                mkdir -p "$runtime_dir/.cfmon"
                cp "$config_dir/deployment.json" "$runtime_dir/.cfmon/deployment.json"
              fi

              save_state() {
                if [[ -f "$runtime_dir/worker/.env" ]]; then
                  cp "$runtime_dir/worker/.env" "$config_dir/worker.env"
                  chmod 600 "$config_dir/worker.env"
                fi
                if [[ -f "$runtime_dir/.cfmon/deployment.json" ]]; then
                  cp "$runtime_dir/.cfmon/deployment.json" "$config_dir/deployment.json"
                  chmod 600 "$config_dir/deployment.json"
                fi
              }
              cleanup() {
                status=$?
                trap - EXIT
                save_state || true
                rm -rf "$runtime_dir"
                exit "$status"
              }
              trap cleanup EXIT

              cd "$runtime_dir"
              node scripts/deploy.ts "''${args[@]}"
            '';
          }}/bin/cfmon";
        };
      };
    };
}
