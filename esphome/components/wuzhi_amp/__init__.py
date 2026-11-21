"""ESPHome external component: BLE bridge to a Wuzhi ZK-502MT amp.

Protocol: Jieli RCSP over BLE (docs/PROTOCOL.md in the Fuzhiapp repo).
"""

import esphome.codegen as cg
from esphome.components import ble_client
import esphome.config_validation as cv
from esphome.const import CONF_ID

DEPENDENCIES = ["ble_client"]
CODEOWNERS = []

CONF_WUZHI_AMP_ID = "wuzhi_amp_id"
CONF_LOG_PRIVATE = "log_private"
CONF_QUERY_TARGET_INFO = "query_target_info"
CONF_AUTH_DELAY = "auth_delay"
CONF_PAIR = "pair"

wuzhi_amp_ns = cg.esphome_ns.namespace("wuzhi_amp")
WuzhiAmp = wuzhi_amp_ns.class_("WuzhiAmp", cg.Component, ble_client.BLEClientNode)

CONFIG_SCHEMA = (
    cv.Schema(
        {
            cv.GenerateID(): cv.declare_id(WuzhiAmp),
            # Read-only GetTargetInfo (opcode 0x03) after auth. Logs the decoded reply.
            cv.Optional(CONF_QUERY_TARGET_INFO, default=True): cv.boolean,
            # Log the amp's Bluetooth address, ID string and raw frames unredacted.
            cv.Optional(CONF_LOG_PRIVATE, default=False): cv.boolean,
            # Wait between enabling notifications and sending the auth challenge.
            cv.Optional(
                CONF_AUTH_DELAY, default="1s"
            ): cv.positive_time_period_milliseconds,
            # Pair with the amp and encrypt the link before auth. Not needed on the
            # ZK-502MT (tested both ways); kept for other models.
            cv.Optional(CONF_PAIR, default=False): cv.boolean,
        }
    )
    .extend(ble_client.BLE_CLIENT_SCHEMA)
    .extend(cv.COMPONENT_SCHEMA)
)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    await ble_client.register_ble_node(var, config)
    cg.add(var.set_query_target_info(config[CONF_QUERY_TARGET_INFO]))
    cg.add(var.set_log_private(config[CONF_LOG_PRIVATE]))
    cg.add(var.set_auth_delay(config[CONF_AUTH_DELAY]))
    cg.add(var.set_pair(config[CONF_PAIR]))
