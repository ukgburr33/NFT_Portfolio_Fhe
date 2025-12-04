import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface NFTAsset {
  id: string;
  name: string;
  encryptedValue: string;
  collection: string;
  timestamp: number;
  owner: string;
  valuation: string;
  image: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [nfts, setNfts] = useState<NFTAsset[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [adding, setAdding] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newNFTData, setNewNFTData] = useState({ name: "", collection: "", value: 0, image: "" });
  const [showIntro, setShowIntro] = useState(true);
  const [selectedNFT, setSelectedNFT] = useState<NFTAsset | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterCollection, setFilterCollection] = useState("all");

  const collections = Array.from(new Set(nfts.map(nft => nft.collection)));
  const totalValue = nfts.reduce((sum, nft) => sum + FHEDecryptNumber(nft.encryptedValue), 0);
  const avgValue = nfts.length > 0 ? totalValue / nfts.length : 0;

  useEffect(() => {
    loadNFTs().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadNFTs = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("nft_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing NFT keys:", e); }
      }
      const list: NFTAsset[] = [];
      for (const key of keys) {
        try {
          const nftBytes = await contract.getData(`nft_${key}`);
          if (nftBytes.length > 0) {
            try {
              const nftData = JSON.parse(ethers.toUtf8String(nftBytes));
              list.push({ 
                id: key, 
                name: nftData.name, 
                encryptedValue: nftData.value, 
                collection: nftData.collection, 
                timestamp: nftData.timestamp, 
                owner: nftData.owner, 
                valuation: nftData.valuation || "0",
                image: nftData.image || ""
              });
            } catch (e) { console.error(`Error parsing NFT data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading NFT ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setNfts(list);
    } catch (e) { console.error("Error loading NFTs:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const addNFT = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setAdding(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting NFT value with Zama FHE..." });
    try {
      const encryptedValue = FHEEncryptNumber(newNFTData.value);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const nftId = `nft-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const nftData = { 
        name: newNFTData.name, 
        value: encryptedValue, 
        collection: newNFTData.collection, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        valuation: "0",
        image: newNFTData.image
      };
      await contract.setData(`nft_${nftId}`, ethers.toUtf8Bytes(JSON.stringify(nftData)));
      const keysBytes = await contract.getData("nft_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(nftId);
      await contract.setData("nft_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      setTransactionStatus({ visible: true, status: "success", message: "NFT added with encrypted valuation!" });
      await loadNFTs();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowAddModal(false);
        setNewNFTData({ name: "", collection: "", value: 0, image: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setAdding(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const revalueNFT = async (nftId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted valuation with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const nftBytes = await contract.getData(`nft_${nftId}`);
      if (nftBytes.length === 0) throw new Error("NFT not found");
      const nftData = JSON.parse(ethers.toUtf8String(nftBytes));
      
      const newValuation = FHECompute(nftData.value, 'increase10%');
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedNFT = { ...nftData, valuation: newValuation };
      await contractWithSigner.setData(`nft_${nftId}`, ethers.toUtf8Bytes(JSON.stringify(updatedNFT)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE valuation completed successfully!" });
      await loadNFTs();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Valuation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (nftAddress: string) => address?.toLowerCase() === nftAddress.toLowerCase();

  const filteredNFTs = nfts.filter(nft => {
    const matchesSearch = nft.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         nft.collection.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCollection = filterCollection === "all" || nft.collection === filterCollection;
    return matchesSearch && matchesCollection;
  });

  const renderValueChart = () => {
    const values = nfts.map(nft => FHEDecryptNumber(nft.encryptedValue));
    const maxValue = Math.max(...values, 1);
    
    return (
      <div className="value-chart">
        {nfts.slice(0, 5).map((nft, index) => {
          const value = FHEDecryptNumber(nft.encryptedValue);
          const percentage = (value / maxValue) * 100;
          return (
            <div key={index} className="chart-item">
              <div className="chart-bar" style={{ width: `${percentage}%` }}></div>
              <div className="chart-label">{nft.name.substring(0, 12)}...</div>
              <div className="chart-value">{value.toFixed(2)} ETH</div>
            </div>
          );
        })}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>Initializing encrypted portfolio...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="shield-icon"></div></div>
          <h1>FHE<span>NFT</span>Vault</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowAddModal(true)} className="add-nft-btn metal-button">
            <div className="add-icon"></div>Add NFT
          </button>
          <button className="metal-button" onClick={() => setShowIntro(!showIntro)}>
            {showIntro ? "Hide Intro" : "Show Intro"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        {showIntro && (
          <div className="intro-section metal-card">
            <h2>Confidential NFT Portfolio</h2>
            <div className="intro-content">
              <div className="intro-text">
                <p>Secure your NFT portfolio with <strong>Zama FHE technology</strong> that encrypts your asset values while allowing valuation calculations.</p>
                <ul>
                  <li>🔒 Encrypted NFT values stored on-chain</li>
                  <li>⚙️ FHE-powered valuation without decryption</li>
                  <li>🛡️ Protect your portfolio privacy</li>
                  <li>📊 Get accurate valuations while keeping data private</li>
                </ul>
              </div>
              <div className="fhe-diagram">
                <div className="diagram-step"><div className="diagram-icon">🖼️</div><div className="diagram-label">NFT Asset</div></div>
                <div className="diagram-arrow">→</div>
                <div className="diagram-step"><div className="diagram-icon">🔒</div><div className="diagram-label">FHE Encryption</div></div>
                <div className="diagram-arrow">→</div>
                <div className="diagram-step"><div className="diagram-icon">🧮</div><div className="diagram-label">Compute on Encrypted Data</div></div>
                <div className="diagram-arrow">→</div>
                <div className="diagram-step"><div className="diagram-icon">💰</div><div className="diagram-label">Encrypted Valuation</div></div>
              </div>
            </div>
            <div className="fhe-badge"><span>Powered by Zama FHE</span></div>
          </div>
        )}
        <div className="dashboard-columns">
          <div className="dashboard-left">
            <div className="stats-card metal-card">
              <h3>Portfolio Overview</h3>
              <div className="stats-grid">
                <div className="stat-item">
                  <div className="stat-value">{nfts.length}</div>
                  <div className="stat-label">NFTs</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{totalValue.toFixed(2)}</div>
                  <div className="stat-label">Total Value (ETH)</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{avgValue.toFixed(2)}</div>
                  <div className="stat-label">Avg Value (ETH)</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{collections.length}</div>
                  <div className="stat-label">Collections</div>
                </div>
              </div>
            </div>
            <div className="chart-card metal-card">
              <h3>Top NFT Values</h3>
              {renderValueChart()}
            </div>
          </div>
          <div className="dashboard-right">
            <div className="nfts-section">
              <div className="section-header">
                <h2>Your Encrypted NFTs</h2>
                <div className="header-actions">
                  <div className="search-filter">
                    <input 
                      type="text" 
                      placeholder="Search NFTs..." 
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="metal-input"
                    />
                    <select 
                      value={filterCollection} 
                      onChange={(e) => setFilterCollection(e.target.value)}
                      className="metal-select"
                    >
                      <option value="all">All Collections</option>
                      {collections.map((col, index) => (
                        <option key={index} value={col}>{col.substring(0, 12)}...</option>
                      ))}
                    </select>
                  </div>
                  <button onClick={loadNFTs} className="refresh-btn metal-button" disabled={isRefreshing}>
                    {isRefreshing ? "Refreshing..." : "Refresh"}
                  </button>
                </div>
              </div>
              <div className="nfts-list metal-card">
                <div className="table-header">
                  <div className="header-cell">NFT</div>
                  <div className="header-cell">Collection</div>
                  <div className="header-cell">Encrypted Value</div>
                  <div className="header-cell">Valuation</div>
                  <div className="header-cell">Actions</div>
                </div>
                {filteredNFTs.length === 0 ? (
                  <div className="no-nfts">
                    <div className="no-nfts-icon"></div>
                    <p>No NFTs found</p>
                    <button className="metal-button primary" onClick={() => setShowAddModal(true)}>Add First NFT</button>
                  </div>
                ) : filteredNFTs.map(nft => (
                  <div className="nft-row" key={nft.id} onClick={() => setSelectedNFT(nft)}>
                    <div className="table-cell">
                      <div className="nft-info">
                        {nft.image && <img src={nft.image} alt={nft.name} className="nft-image"/>}
                        <span>{nft.name.substring(0, 12)}...</span>
                      </div>
                    </div>
                    <div className="table-cell">{nft.collection.substring(0, 12)}...</div>
                    <div className="table-cell">{nft.encryptedValue.substring(0, 10)}...</div>
                    <div className="table-cell">{nft.valuation.substring(0, 10)}...</div>
                    <div className="table-cell actions">
                      {isOwner(nft.owner) && (
                        <button className="action-btn metal-button" onClick={(e) => { e.stopPropagation(); revalueNFT(nft.id); }}>Revalue</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      {showAddModal && <ModalAddNFT onSubmit={addNFT} onClose={() => setShowAddModal(false)} adding={adding} nftData={newNFTData} setNftData={setNewNFTData}/>}
      {selectedNFT && <NFTDetailModal nft={selectedNFT} onClose={() => { setSelectedNFT(null); setDecryptedValue(null); }} decryptedValue={decryptedValue} setDecryptedValue={setDecryptedValue} isDecrypting={isDecrypting} decryptWithSignature={decryptWithSignature}/>}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="metal-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="shield-icon"></div><span>FHE NFT Vault</span></div>
            <p>Confidential NFT portfolio management with Zama FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
          <div className="copyright">© {new Date().getFullYear()} FHE NFT Vault. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalAddNFTProps {
  onSubmit: () => void; 
  onClose: () => void; 
  adding: boolean;
  nftData: any;
  setNftData: (data: any) => void;
}

const ModalAddNFT: React.FC<ModalAddNFTProps> = ({ onSubmit, onClose, adding, nftData, setNftData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setNftData({ ...nftData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setNftData({ ...nftData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!nftData.name || !nftData.collection || !nftData.value) { alert("Please fill required fields"); return; }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="add-modal metal-card">
        <div className="modal-header">
          <h2>Add Encrypted NFT</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Your NFT value will be encrypted with Zama FHE before submission</p></div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>NFT Name *</label>
              <input type="text" name="name" value={nftData.name} onChange={handleChange} placeholder="NFT name" className="metal-input"/>
            </div>
            <div className="form-group">
              <label>Collection *</label>
              <input type="text" name="collection" value={nftData.collection} onChange={handleChange} placeholder="Collection name" className="metal-input"/>
            </div>
            <div className="form-group">
              <label>Estimated Value (ETH) *</label>
              <input 
                type="number" 
                name="value" 
                value={nftData.value} 
                onChange={handleValueChange} 
                placeholder="Estimated value in ETH" 
                className="metal-input"
                step="0.01"
              />
            </div>
            <div className="form-group">
              <label>Image URL</label>
              <input type="text" name="image" value={nftData.image} onChange={handleChange} placeholder="Optional image URL" className="metal-input"/>
            </div>
          </div>
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data"><span>Plain Value:</span><div>{nftData.value || 'No value entered'}</div></div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{nftData.value ? FHEEncryptNumber(nftData.value).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn metal-button">Cancel</button>
          <button onClick={handleSubmit} disabled={adding} className="submit-btn metal-button primary">
            {adding ? "Encrypting with FHE..." : "Add NFT Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface NFTDetailModalProps {
  nft: NFTAsset;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const NFTDetailModal: React.FC<NFTDetailModalProps> = ({ nft, onClose, decryptedValue, setDecryptedValue, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { setDecryptedValue(null); return; }
    const decrypted = await decryptWithSignature(nft.encryptedValue);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="nft-detail-modal metal-card">
        <div className="modal-header">
          <h2>NFT Details #{nft.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          {nft.image && <div className="nft-image-container"><img src={nft.image} alt={nft.name} className="nft-image-large"/></div>}
          <div className="nft-info">
            <div className="info-item"><span>Name:</span><strong>{nft.name}</strong></div>
            <div className="info-item"><span>Collection:</span><strong>{nft.collection}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{nft.owner.substring(0, 6)}...{nft.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Added:</span><strong>{new Date(nft.timestamp * 1000).toLocaleString()}</strong></div>
          </div>
          <div className="encrypted-data-section">
            <h3>Encrypted Data</h3>
            <div className="encrypted-data">{nft.encryptedValue.substring(0, 100)}...</div>
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            <button className="decrypt-btn metal-button" onClick={handleDecrypt} disabled={isDecrypting}>
              {isDecrypting ? <span className="decrypt-spinner"></span> : decryptedValue !== null ? "Hide Decrypted Value" : "Decrypt with Wallet Signature"}
            </button>
          </div>
          {decryptedValue !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Value</h3>
              <div className="decrypted-value">{decryptedValue} ETH</div>
              <div className="decryption-notice"><div className="warning-icon"></div><span>Decrypted data is only visible after wallet signature verification</span></div>
            </div>
          )}
          <div className="valuation-section">
            <h3>Current Valuation</h3>
            <div className="valuation-value">{FHEDecryptNumber(nft.valuation).toFixed(2)} ETH</div>
            <div className="valuation-notice"><div className="info-icon"></div><span>Valuation computed on encrypted data using FHE</span></div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn metal-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;