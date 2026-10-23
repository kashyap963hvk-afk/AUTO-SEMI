// sync_fifo_props.svh
// Formal properties for sync_fifo, included only when FORMAL is defined.
// The abstract model below is derived from the interface contract, not from
// the implementation, so an implementation defect shows up as a counterexample.

  reg f_past_valid = 1'b0;
  always @(posedge clk) f_past_valid <= 1'b1;

  // Start every trace in reset.
  always @(*) if (!f_past_valid) assume (!rst_n);

  // Contract-level acceptance rules (REQ-FUNC-003, REQ-FUNC-004, REQ-FUNC-005).
  wire f_rd_acc = rd_en && (f_count != 0);
  wire f_wr_acc = wr_en && ((f_count != DEPTH) || (ALLOW_WRITE_WHEN_FULL_WITH_READ && f_rd_acc));

  reg [CW-1:0] f_count;
  always @(posedge clk) begin
    if (!rst_n)                     f_count <= {CW{1'b0}};
    else if (f_wr_acc && !f_rd_acc) f_count <= f_count + 1'b1;
    else if (f_rd_acc && !f_wr_acc) f_count <= f_count - 1'b1;
  end

  // Occupancy and flags (REQ-FUNC-002, REQ-FUNC-003, REQ-FUNC-004).
  always @(*) if (f_past_valid && rst_n) begin
    assert (f_count <= DEPTH);
    assert (count == f_count);
    assert (full  == (f_count == DEPTH));
    assert (empty == (f_count == 0));
  end

  // Reset establishes the documented initial state (REQ-RST-001).
  always @(posedge clk) if (f_past_valid && $past(!rst_n)) begin
    assert (empty);
    assert (!full);
    assert (count == 0);
  end

  // Data integrity and ordering (REQ-FUNC-001): track one arbitrary accepted
  // item and check it is read back unchanged after every older item.
  (* anyseq *) wire f_pick;
  reg              f_tracking;
  reg [WIDTH-1:0]  f_value;
  reg [CW-1:0]     f_ahead;   // items that must leave before the tracked item

  always @(posedge clk) begin
    if (!rst_n) begin
      f_tracking <= 1'b0;
    end else if (!f_tracking && f_pick && f_wr_acc) begin
      f_tracking <= 1'b1;
      f_value    <= wr_data;
      f_ahead    <= f_count - (f_rd_acc ? 1'b1 : 1'b0);
    end else if (f_tracking && f_rd_acc) begin
      if (f_ahead == 0) f_tracking <= 1'b0;
      else              f_ahead    <= f_ahead - 1'b1;
    end
  end

  always @(*) if (f_past_valid && rst_n && f_tracking) begin
    assert (f_ahead < f_count);
    if (f_ahead == 0) assert (rd_data == f_value);
  end

  // Implementation invariants that make the k-induction proof succeed.
  always @(*) if (f_past_valid && rst_n) begin
    assert (count_q[AW-1:0] == wr_ptr - rd_ptr);
    if (f_tracking) assert (mem[rd_ptr + f_ahead[AW-1:0]] == f_value);
  end

  // Reachability: make sure the properties above are not vacuous.
  always @(*) if (f_past_valid && rst_n) cover (full);
  always @(posedge clk) if (f_past_valid && rst_n && $past(f_tracking) && !f_tracking) cover (1'b1);
