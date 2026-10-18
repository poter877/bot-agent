"""``hermes account`` subcommand parser."""

from __future__ import annotations

from typing import Callable


def build_account_parser(subparsers, *, cmd_account: Callable) -> None:
    """Attach the ``account`` subcommand to ``subparsers``."""
    account_parser = subparsers.add_parser(
        "account", help="Sign the company backend account in or out (device-code login)")
    account_subparsers = account_parser.add_subparsers(dest="account_action")
    account_login = account_subparsers.add_parser(
        "login", help="Sign in to the company backend with a device code approved in your browser")
    account_login.add_argument(
        "--no-browser", action="store_true", help="Do not auto-open the browser for approval")
    account_login.add_argument("--timeout", type=float, help="HTTP request timeout in seconds")
    account_subparsers.add_parser(
        "logout", help="Remove this profile's stored company account token")
    account_parser.set_defaults(func=cmd_account)
