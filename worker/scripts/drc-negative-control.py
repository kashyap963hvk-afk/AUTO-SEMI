# Negative control for the KLayout DRC set-up: a clean DRC result only means something if the
# same deck, in the same mode, flags known violations. This plants three FEOL violations into a
# copy of a routed GDS; run the deck on the copy and expect difftap.1, poly.1a and nwell.1.
#   klayout -zz -rd in_gds=6_final.gds -rd out_gds=planted.gds -r drc-negative-control.py
#   klayout -zz -rd in_gds=planted.gds -rd report_file=planted.lyrdb -r drc.lydrc
import pya

ly = pya.Layout()
ly.read(in_gds)  # noqa: F821 - provided by klayout -rd
top = ly.top_cell()


def box(layer, datatype, x0, y0, x1, y1):
    top.shapes(ly.layer(layer, datatype)).insert(pya.DBox(x0, y0, x1, y1).to_itype(ly.dbu))


box(65, 20, 1.0, 1.0, 1.10, 3.0)  # diff 0.10 um wide: difftap.1 (min 0.15 um)
box(66, 20, 5.0, 1.0, 5.10, 3.0)  # poly 0.10 um wide: poly.1a (min 0.15 um)
box(64, 20, 9.0, 1.0, 9.30, 3.0)  # nwell 0.30 um wide: nwell.1 (min 0.84 um)
ly.write(out_gds)  # noqa: F821
print(f"planted 3 FEOL violations -> {out_gds}")  # noqa: F821
