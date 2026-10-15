"""Company-owned cloud computer; only Hono holds infrastructure credentials."""

from tools.computer_use.backend import ComputerUseProvider


class CompanyCloudProvider(ComputerUseProvider):
    name = "company-cloud"
    display_name = "Account cloud computer"

    def create_backend(self, *, permission_mode):
        from tools.computer_use.cloud_backend import CompanyCloudBackend
        return CompanyCloudBackend()

    def action_scope(self):
        from tools.cloud_computer.control import cloud_action_scope
        return cloud_action_scope()

    def desktop_identity(self):
        # Account changes invalidate the handle rather than rebinding an old session to a new user.
        return "company-cloud"

    def is_available(self):
        from account_backend_session import AccountBackendError, bot_backend_base
        try:
            return bool(bot_backend_base())
        except AccountBackendError:
            return False


def register(ctx):
    ctx.register_computer_use_provider(CompanyCloudProvider())
