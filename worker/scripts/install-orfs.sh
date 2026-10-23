#!/usr/bin/env bash
# Installs the physical-design toolchain exactly as verified for Auto-VLSI:
#   OpenROAD 2.0-12381-g01bba3695 + Yosys 0.38+92 (litex-hub conda builds, 2024-02-23),
#   KLayout 0.28.16 (Ubuntu 24.04), OpenROAD-flow-scripts at d5cc6022 (2024-02-22) with the
#   sky130hd platform only (sparse checkout).
# Then export the printed ORFS_* variables for the worker.
set -euo pipefail
PREFIX=${PREFIX:-/opt}
MM=$PREFIX/mm
mkdir -p "$MM"
curl -sSL https://conda.anaconda.org/conda-forge/linux-64/micromamba-2.9.0-0.tar.bz2 | tar xj -C "$MM" bin/micromamba
export MAMBA_ROOT_PREFIX=$MM/root
CH="-c litex-hub -c conda-forge -c https://repo.anaconda.com/pkgs/main"
"$MM/bin/micromamba" create -y -p "$PREFIX/eda" $CH openroad=2.0_12381_g01bba3695
"$MM/bin/micromamba" install -y -p "$PREFIX/eda" $CH "fmt=8" yosys=0.38_93_g84116c9a3
${SUDO-sudo} apt-get install -y --no-install-recommends klayout time
git clone -q --filter=blob:none --no-checkout https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts "$PREFIX/orfs"
cd "$PREFIX/orfs"
git sparse-checkout init --no-cone
printf '/flow/*\n!/flow/platforms/*\n/flow/platforms/sky130hd/\n/flow/platforms/sky130hs/rcx_patterns.rules\n!/flow/designs/*\n' > .git/info/sparse-checkout
git checkout -q d5cc6022ae3c91b8178fabd2e1a39b67a58a8756
"$PREFIX/eda/bin/openroad" -version
cat <<VARS
export ORFS_FLOW_HOME=$PREFIX/orfs/flow
export ORFS_OPENROAD=$PREFIX/eda/bin/openroad
export ORFS_YOSYS=$PREFIX/eda/bin/yosys
export ORFS_KLAYOUT=$(command -v klayout)
VARS
