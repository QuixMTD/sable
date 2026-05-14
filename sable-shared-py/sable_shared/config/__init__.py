from sable_shared.config.env import (
    EnvError,
    env_flag,
    load_dotenv_if_present,
    optional_env,
    optional_env_int,
    require_env,
    require_env_int,
)

# Redis bits are re-exported only when the optional `redis` package is
# installed — keeps `from sable_shared.config import require_env` working
# in services that don't need Redis.
try:
    from sable_shared.config.redis import (
        RedisConfig,
        close_redis,
        create_redis,
        ping_redis,
    )

    _HAS_REDIS = True
except ImportError:  # pragma: no cover — optional dep
    _HAS_REDIS = False

__all__ = [
    "EnvError",
    "env_flag",
    "load_dotenv_if_present",
    "optional_env",
    "optional_env_int",
    "require_env",
    "require_env_int",
]

if _HAS_REDIS:
    __all__ += ["RedisConfig", "close_redis", "create_redis", "ping_redis"]
