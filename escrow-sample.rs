use anyhow::Result;
use anyhow::anyhow;
use anyhow::bail;
use ark_rs::core::ArkAddress;
use ark_rs::core::UNSPENDABLE_KEY;
use bitcoin::Network;
use bitcoin::PublicKey;
use bitcoin::ScriptBuf;
use bitcoin::XOnlyPublicKey;
use bitcoin::opcodes::all::*;
use bitcoin::taproot::TaprootBuilder;
use bitcoin::taproot::TaprootSpendInfo;
use serde::Deserialize;
use serde::Serialize;
use std::str::FromStr;

/// Represents a script with its weight for taproot tree construction.
#[derive(Debug, Clone)]
struct TaprootScriptItem {
    script: ScriptBuf,
    weight: u32,
}

/// Internal tree node for building the taproot tree structure.
#[derive(Debug, Clone)]
enum TaprootTreeNode {
    Leaf {
        script: ScriptBuf,
        weight: u32,
    },
    Branch {
        left: Box<TaprootTreeNode>,
        right: Box<TaprootTreeNode>,
        weight: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArkadeTaprootOptions {
    /// The borrower's public key.
    pub borrower_pk: XOnlyPublicKey,
    /// The lender's public key.
    pub lender_pk: XOnlyPublicKey,
    /// The hub's public key.
    pub hub_pk: XOnlyPublicKey,
    /// The Arkade server's public key.
    pub server_pk: XOnlyPublicKey,
    pub unilateral_exit_delay: bitcoin::Sequence,
}

impl ArkadeTaprootOptions {
    fn build_taproot(&self) -> Result<TaprootSpendInfo> {
        let internal_pubkey = PublicKey::from_str(UNSPENDABLE_KEY).expect("key");
        let internal_key = XOnlyPublicKey::from(internal_pubkey);

        // Create script list with weights
        // Lower weight = more likely to be used = shallower in tree
        let scripts = vec![
            TaprootScriptItem {
                script: self.borrower_hub_script(),
                weight: 1,
            },
            TaprootScriptItem {
                script: self.lender_hub_script(),
                weight: 1,
            },
            TaprootScriptItem {
                script: self.borrower_lender_script(),
                weight: 1,
            },
            TaprootScriptItem {
                script: self.unilateral_borrower_hub_script(),
                weight: 1,
            },
            TaprootScriptItem {
                script: self.unilateral_lender_hub_script(),
                weight: 1,
            },
            TaprootScriptItem {
                script: self.unilateral_borrower_lender_script(),
                weight: 1,
            },
        ];

        // Build the tree using the weight-based algorithm
        let tree = Self::taproot_list_to_tree(scripts)?;

        // Create TaprootBuilder and add the tree
        let builder = TaprootBuilder::new();
        let builder = Self::add_tree_to_builder(builder, &tree, 0)?;

        let secp = bitcoin::secp256k1::Secp256k1::new();
        let taproot_spend_info = builder
            .finalize(&secp, internal_key)
            .map_err(|_| anyhow!("Failed to finalize taproot"))?;

        Ok(taproot_spend_info)
    }

    pub fn borrower_hub_script(&self) -> ScriptBuf {
        ScriptBuf::builder()
            .push_x_only_key(&self.borrower_pk)
            .push_opcode(OP_CHECKSIGVERIFY)
            .push_x_only_key(&self.hub_pk)
            .push_opcode(OP_CHECKSIGVERIFY)
            .push_x_only_key(&self.server_pk)
            .push_opcode(OP_CHECKSIG)
            .into_script()
    }

    pub fn lender_hub_script(&self) -> ScriptBuf {
        ScriptBuf::builder()
            .push_x_only_key(&self.lender_pk)
            .push_opcode(OP_CHECKSIGVERIFY)
            .push_x_only_key(&self.hub_pk)
            .push_opcode(OP_CHECKSIGVERIFY)
            .push_x_only_key(&self.server_pk)
            .push_opcode(OP_CHECKSIG)
            .into_script()
    }

    pub fn borrower_lender_script(&self) -> ScriptBuf {
        ScriptBuf::builder()
            .push_x_only_key(&self.borrower_pk)
            .push_opcode(OP_CHECKSIGVERIFY)
            .push_x_only_key(&self.lender_pk)
            .push_opcode(OP_CHECKSIGVERIFY)
            .push_x_only_key(&self.server_pk)
            .push_opcode(OP_CHECKSIG)
            .into_script()
    }

    pub fn unilateral_borrower_hub_script(&self) -> ScriptBuf {
        ScriptBuf::builder()
            .push_int(self.unilateral_exit_delay.to_consensus_u32() as i64)
            .push_opcode(OP_CSV)
            .push_opcode(OP_DROP)
            .push_x_only_key(&self.borrower_pk)
            .push_opcode(OP_CHECKSIGVERIFY)
            .push_x_only_key(&self.hub_pk)
            .push_opcode(OP_CHECKSIG)
            .into_script()
    }

    pub fn unilateral_lender_hub_script(&self) -> ScriptBuf {
        ScriptBuf::builder()
            .push_int(self.unilateral_exit_delay.to_consensus_u32() as i64)
            .push_opcode(OP_CSV)
            .push_opcode(OP_DROP)
            .push_x_only_key(&self.lender_pk)
            .push_opcode(OP_CHECKSIGVERIFY)
            .push_x_only_key(&self.hub_pk)
            .push_opcode(OP_CHECKSIG)
            .into_script()
    }

    pub fn unilateral_borrower_lender_script(&self) -> ScriptBuf {
        ScriptBuf::builder()
            .push_int(self.unilateral_exit_delay.to_consensus_u32() as i64)
            .push_opcode(OP_CSV)
            .push_opcode(OP_DROP)
            .push_x_only_key(&self.borrower_pk)
            .push_opcode(OP_CHECKSIGVERIFY)
            .push_x_only_key(&self.lender_pk)
            .push_opcode(OP_CHECKSIG)
            .into_script()
    }

    /// Build a balanced taproot tree from a list of scripts with weights
    /// Following the TypeScript algorithm from scure-btc-signer
    fn taproot_list_to_tree(scripts: Vec<TaprootScriptItem>) -> Result<TaprootTreeNode> {
        if scripts.is_empty() {
            bail!("Empty script list");
        }

        // Clone input and convert to nodes
        let mut lst: Vec<TaprootTreeNode> = scripts
            .into_iter()
            .map(|item| TaprootTreeNode::Leaf {
                script: item.script,
                weight: item.weight,
            })
            .collect();

        // Build tree by combining nodes with smallest weights
        while lst.len() >= 2 {
            // Sort: elements with smallest weight are at the end of queue
            lst.sort_by(|a, b| {
                let weight_a = match a {
                    TaprootTreeNode::Leaf { weight, .. } => *weight,
                    TaprootTreeNode::Branch { weight, .. } => *weight,
                };
                let weight_b = match b {
                    TaprootTreeNode::Leaf { weight, .. } => *weight,
                    TaprootTreeNode::Branch { weight, .. } => *weight,
                };
                // Reverse comparison to put smallest at end
                weight_b.cmp(&weight_a)
            });

            // Pop the two smallest weight nodes
            let b = lst.pop().expect("an element");
            let a = lst.pop().expect("an element");

            // Calculate combined weight
            let weight_a = match &a {
                TaprootTreeNode::Leaf { weight, .. } => *weight,
                TaprootTreeNode::Branch { weight, .. } => *weight,
            };
            let weight_b = match &b {
                TaprootTreeNode::Leaf { weight, .. } => *weight,
                TaprootTreeNode::Branch { weight, .. } => *weight,
            };

            // Create branch with combined weight
            lst.push(TaprootTreeNode::Branch {
                weight: weight_a + weight_b,
                left: Box::new(a),
                right: Box::new(b),
            });
        }

        // Return the root node
        Ok(lst.into_iter().next().expect("root node"))
    }

    /// Recursively add tree nodes to TaprootBuilder
    fn add_tree_to_builder(
        builder: TaprootBuilder,
        node: &TaprootTreeNode,
        depth: u8,
    ) -> Result<TaprootBuilder> {
        match node {
            TaprootTreeNode::Leaf { script, .. } => builder
                .add_leaf(depth, script.clone())
                .map_err(|_| anyhow!("Failed to add leaf")),
            TaprootTreeNode::Branch { left, right, .. } => {
                let builder = Self::add_tree_to_builder(builder, left, depth + 1)?;
                Self::add_tree_to_builder(builder, right, depth + 1)
            }
        }
    }
}

pub struct ArkadeScript {
    options: ArkadeTaprootOptions,
    taproot_spend_info: TaprootSpendInfo,
    network: Network,
}

impl ArkadeScript {
    pub fn new(options: ArkadeTaprootOptions, network: Network) -> Result<Self> {
        let taproot_spend_info = options.build_taproot()?;

        Ok(Self {
            options,
            taproot_spend_info,
            network,
        })
    }

    pub fn taproot_spend_info(&self) -> &TaprootSpendInfo {
        &self.taproot_spend_info
    }

    pub fn script_pubkey(&self) -> ScriptBuf {
        ScriptBuf::builder()
            .push_opcode(OP_PUSHNUM_1)
            .push_slice(self.taproot_spend_info.output_key().serialize())
            .into_script()
    }

    pub fn address(&self) -> ArkAddress {
        ArkAddress::new(
            self.network,
            self.options.server_pk,
            self.taproot_spend_info().output_key(),
        )
    }

    pub fn borrower_hub_script(&self) -> ScriptBuf {
        self.options.borrower_hub_script()
    }

    pub fn lender_hub_script(&self) -> ScriptBuf {
        self.options.lender_hub_script()
    }

    pub fn borrower_lender_script(&self) -> ScriptBuf {
        self.options.borrower_lender_script()
    }

    pub fn unilateral_borrower_hub_script(&self) -> ScriptBuf {
        self.options.unilateral_borrower_hub_script()
    }

    pub fn unilateral_lender_hub_script(&self) -> ScriptBuf {
        self.options.unilateral_lender_hub_script()
    }

    pub fn unilateral_borrower_lender_script(&self) -> ScriptBuf {
        self.options.unilateral_borrower_lender_script()
    }

    pub fn tapscripts(self) -> Vec<ScriptBuf> {
        vec![
            self.borrower_hub_script(),
            self.lender_hub_script(),
            self.borrower_lender_script(),
            self.unilateral_borrower_hub_script(),
            self.unilateral_lender_hub_script(),
            self.unilateral_borrower_lender_script(),
        ]
    }
}
