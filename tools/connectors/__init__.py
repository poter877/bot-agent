"""MCP OAuth helpers shared with the gateway layer.

Only :mod:`tools.connectors.mcp_oauth` remains after the managed connector
retirement; the module stays a regular package (``__init__.py`` present) so
``setuptools.packages.find`` keeps shipping it — a namespace package would be
dropped from the wheel and strand ``tui_gateway.mcp_oauth_sessions``.
"""
