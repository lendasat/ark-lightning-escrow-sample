# frozen_string_literal: true

# Load the native extension (.so / .dylib / .bundle).
# Cargo produces `libark_escrow_ruby.so` but Ruby needs the file named
# `ark_escrow_ruby.so` so that Init_ark_escrow_ruby matches.
# The build step (just build-ruby) creates the symlink.
ws_root = File.expand_path("../..", __dir__)

candidates = [
  File.join(ws_root, "target", "release", "ark_escrow_ruby"),
  File.join(ws_root, "target", "debug", "ark_escrow_ruby"),
]

loaded = candidates.any? do |path|
  begin
    require path
    true
  rescue LoadError
    false
  end
end

raise LoadError, "Cannot find ark_escrow_ruby.so — run: just build-ruby" unless loaded
