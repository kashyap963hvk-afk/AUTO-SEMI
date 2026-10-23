# EDA worker image: pinned open-source toolchain, non-root, no secrets baked in.
# Run with: docker run --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
#             --pids-limit 256 --memory 4g --cpus 2 -e WORKER_TOKEN=... -p 8090:8090 devin-vlsi-worker
FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
# Versions verified in this repository: Verilator 5.020, Icarus 12.0, Yosys 0.33, z3 4.8.12 (Ubuntu 24.04 packages).
RUN apt-get update \
 && apt-get install -y --no-install-recommends verilator iverilog yosys z3 python3 python3-pip python3-venv git make ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# SymbiYosys pinned to the tag matching the packaged Yosys.
RUN git clone --depth 1 --branch yosys-0.33 https://github.com/YosysHQ/sby.git /opt/sby \
 && make -C /opt/sby install PREFIX=/usr/local \
 && rm -rf /opt/sby

# Optional physical-design toolchain (OpenROAD + ORFS sky130hd + KLayout): docker build --build-arg WITH_ORFS=1 .
ARG WITH_ORFS=0
COPY scripts/install-orfs.sh /tmp/install-orfs.sh
RUN if [ "$WITH_ORFS" = "1" ]; then apt-get update && apt-get install -y --no-install-recommends curl bzip2 && SUDO= PREFIX=/opt bash /tmp/install-orfs.sh && rm -rf /var/lib/apt/lists/*; fi
ENV ORFS_FLOW_HOME=/opt/orfs/flow ORFS_OPENROAD=/opt/eda/bin/openroad ORFS_YOSYS=/opt/eda/bin/yosys ORFS_KLAYOUT=/usr/bin/klayout

RUN useradd --create-home --uid 10001 eda
WORKDIR /app
COPY pyproject.toml ./
COPY devin_vlsi_worker ./devin_vlsi_worker
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir . && ln -sf /opt/venv/bin/python3 /usr/local/bin/python3
ENV PATH=/opt/venv/bin:$PATH TMPDIR=/tmp
USER eda
EXPOSE 8090
HEALTHCHECK CMD python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8090/health')"
CMD ["python3", "-m", "devin_vlsi_worker", "serve", "--host", "0.0.0.0", "--port", "8090"]
