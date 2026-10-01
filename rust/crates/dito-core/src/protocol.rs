//! 手机 host、relay 与客户端共用的 wire protocol 类型。
//!
//! 字段名刻意保持 `docs/protocol.md` 的 camelCase，Rust 端新增消息必须先补快照测试。

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PairHello {
    pub name: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatUser {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatVoice {
    pub id: String,
    pub mime: String,
    #[serde(rename = "audioB64")]
    pub audio_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatDelta {
    pub id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatTool {
    pub id: String,
    pub name: String,
    #[serde(rename = "argsShort")]
    pub args_short: String,
    pub state: ToolState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ToolState {
    Start,
    End,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatEnd {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatError {
    pub id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ForwardTo {
    #[serde(rename = "type")]
    pub kind: String,
    pub to: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ForwardFrom {
    #[serde(rename = "type")]
    pub kind: String,
    pub from: String,
    #[serde(rename = "deviceToken")]
    pub device_token: String,
    pub payload: Value,
}

impl ForwardTo {
    pub fn new(to: impl Into<String>, payload: Value) -> Self {
        Self {
            kind: "forward".into(),
            to: to.into(),
            payload,
        }
    }
}

impl ForwardFrom {
    pub fn new(from: impl Into<String>, device_token: impl Into<String>, payload: Value) -> Self {
        Self {
            kind: "forward".into(),
            from: from.into(),
            device_token: device_token.into(),
            payload,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chat_messages_match_mobile_contract() {
        let user = ChatUser {
            id: "turn-1".into(),
            text: "你好".into(),
        };
        assert_eq!(
            serde_json::to_value(user).unwrap(),
            json!({ "id": "turn-1", "text": "你好" })
        );

        let voice = ChatVoice {
            id: "turn-2".into(),
            mime: "audio/wav".into(),
            audio_b64: "AQI=".into(),
        };
        assert_eq!(
            serde_json::to_value(voice).unwrap(),
            json!({ "id": "turn-2", "mime": "audio/wav", "audioB64": "AQI=" })
        );

        let tool = ChatTool {
            id: "turn-1".into(),
            name: "system_info".into(),
            args_short: "{}".into(),
            state: ToolState::Start,
        };
        assert_eq!(
            serde_json::to_value(tool).unwrap(),
            json!({ "id": "turn-1", "name": "system_info", "argsShort": "{}", "state": "start" })
        );
    }

    #[test]
    fn forward_envelopes_keep_wire_names() {
        let msg = ForwardFrom::new(
            "conn-1",
            "device-token",
            json!({ "type": "chat.user", "id": "x", "text": "hi" }),
        );
        let encoded = serde_json::to_value(msg).unwrap();
        assert_eq!(encoded["type"], "forward");
        assert_eq!(encoded["deviceToken"], "device-token");
        assert_eq!(encoded["payload"]["type"], "chat.user");
    }
}
