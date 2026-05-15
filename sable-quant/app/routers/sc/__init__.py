"""Equities (sable-sc) quant surface.

All endpoints here mount under the /sc namespace (see app.main). The
maths is asset-class agnostic — sable-sc sources the equity OHLCV /
fundamentals (via EODHD) and posts them in. Crypto and property get
their own sibling packages (app.routers.crypto, app.routers.re) when
those modules' quant is built; shared maths is reused, not duplicated.
"""
