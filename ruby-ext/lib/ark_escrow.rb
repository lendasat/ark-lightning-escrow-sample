# frozen_string_literal: true

# Load the native extension (.so / .dylib / .bundle)
begin
  require_relative "../target/release/libark_escrow_ruby"
rescue LoadError
  # Fall back to debug build
  require_relative "../target/debug/libark_escrow_ruby"
end
