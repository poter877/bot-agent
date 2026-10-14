"""Account auth bridge (``methods_account_auth.py``): Better Auth relayed by the agent subprocess.

The agent subprocess is the ONLY backend client (doc《后端服务》§6): the desktop never talks
to bot-backend directly, and the Better Auth session cookies live inside the subprocess's
jar — only the verified profile crosses the wire back to the desktop. ``error`` carries a
server-provided, form-displayable message (never credentials).
"""

from __future__ import annotations

from .base import Params, Result
from .registry import method


class AccountAuthUser(Result):
    id: str
    email: str
    name: str


class AccountAuthStatusResult(Result):
    authenticated: bool = False
    user: AccountAuthUser | None = None
    error: str | None = None


class AccountAuthSignInParams(Params):
    email: str
    password: str


class AccountAuthSignUpParams(Params):
    name: str
    email: str
    password: str


class AccountAuthSignOutResult(Result):
    ok: bool = True


method("accountAuth.status", params=Params, result=AccountAuthStatusResult,
       doc="Current Better Auth session as seen by the agent subprocess's authoritative check.")
method("accountAuth.signIn", params=AccountAuthSignInParams, result=AccountAuthStatusResult,
       doc="Email+password sign-in relayed to the account backend; establishes the subprocess-held session.")
method("accountAuth.signUp", params=AccountAuthSignUpParams, result=AccountAuthStatusResult,
       doc="Email+password sign-up relayed to the account backend; establishes the subprocess-held session.")
method("accountAuth.signOut", params=Params, result=AccountAuthSignOutResult,
       doc="Revoke the subprocess-held Better Auth session.")
