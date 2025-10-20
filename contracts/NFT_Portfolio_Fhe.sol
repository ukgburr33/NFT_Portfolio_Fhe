pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract NFTPortfolioFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchClosed;

    struct EncryptedNFT {
        euint32 encryptedValue;
        euint32 encryptedWeight;
    }

    mapping(uint256 => EncryptedNFT[]) public portfolioEntries; // batchId => array of EncryptedNFT

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event NFTSubmitted(address indexed provider, uint256 batchId, uint256 indexInBatch);
    event PortfolioValuationRequested(uint256 indexed requestId, uint256 batchId, bytes32 stateHash);
    event PortfolioValuationCompleted(uint256 indexed requestId, uint256 batchId, uint256 totalValue);

    error NotOwner();
    error NotProvider();
    error PausedError();
    error CooldownActive();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error BatchNotClosed();
    error FHENotInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    modifier respectCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        currentBatchId = 1; // Start with batch 1
        emit BatchOpened(currentBatchId);
        cooldownSeconds = 60; // Default 60 seconds cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        delete isProvider[provider];
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused) {
            paused = true;
            emit Paused(msg.sender);
        } else {
            paused = false;
            emit Unpaused(msg.sender);
        }
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        emit CooldownSecondsSet(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openNewBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        isBatchClosed[currentBatchId] = false;
        emit BatchOpened(currentBatchId);
    }

    function closeCurrentBatch() external onlyOwner whenNotPaused {
        if (isBatchClosed[currentBatchId]) revert InvalidBatch();
        isBatchClosed[currentBatchId] = true;
        emit BatchClosed(currentBatchId);
    }

    function submitEncryptedNFT(
        euint32 encryptedValue,
        euint32 encryptedWeight
    ) external onlyProvider whenNotPaused respectCooldown {
        _initIfNeeded(encryptedValue);
        _initIfNeeded(encryptedWeight);

        if (isBatchClosed[currentBatchId]) revert BatchNotClosed();

        portfolioEntries[currentBatchId].push(EncryptedNFT(encryptedValue, encryptedWeight));
        lastSubmissionTime[msg.sender] = block.timestamp;

        emit NFTSubmitted(
            msg.sender,
            currentBatchId,
            portfolioEntries[currentBatchId].length - 1
        );
    }

    function requestPortfolioValuation(uint256 batchId) external whenNotPaused respectCooldown {
        if (!isBatchClosed[batchId]) revert InvalidBatch();
        if (portfolioEntries[batchId].length == 0) revert InvalidBatch(); // No NFTs in batch

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        euint32 encryptedTotalValue = FHE.asEuint32(0);
        uint256 numNFTs = portfolioEntries[batchId].length;

        for (uint256 i = 0; i < numNFTs; ++i) {
            EncryptedNFT storage nft = portfolioEntries[batchId][i];
            encryptedTotalValue = encryptedTotalValue.add(nft.encryptedValue.mul(nft.encryptedWeight));
        }

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = encryptedTotalValue.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });

        emit PortfolioValuationRequested(requestId, batchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        // Security: Replay protection prevents processing the same decryption request multiple times.

        DecryptionContext memory ctx = decryptionContexts[requestId];
        uint256 batchId = ctx.batchId;

        // Security: State verification ensures that the contract state (specifically, the ciphertexts
        // that were supposed to be decrypted) has not changed since the decryption was requested.
        // This prevents scenarios where an attacker might alter the data after a request is made
        // but before it's processed, leading to inconsistent or maliciously manipulated results.
        bytes32[] memory currentCts = new bytes32[](1);
        if (portfolioEntries[batchId].length == 0) revert InvalidBatch(); // Should not happen if request was valid
        euint32 currentEncryptedTotalValue = FHE.asEuint32(0);
        for (uint256 i = 0; i < portfolioEntries[batchId].length; ++i) {
            EncryptedNFT storage nft = portfolioEntries[batchId][i];
            currentEncryptedTotalValue = currentEncryptedTotalValue.add(nft.encryptedValue.mul(nft.encryptedWeight));
        }
        currentCts[0] = currentEncryptedTotalValue.toBytes32();
        bytes32 currentHash = _hashCiphertexts(currentCts);

        if (currentHash != ctx.stateHash) revert StateMismatch();

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        uint256 totalValue = abi.decode(cleartexts, (uint256));
        decryptionContexts[requestId].processed = true;
        emit PortfolioValuationCompleted(requestId, batchId, totalValue);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 value) internal {
        if (!value.isInitialized()) revert FHENotInitialized();
    }

    function _requireInitialized(euint32 value) internal view {
        if (!value.isInitialized()) revert FHENotInitialized();
    }
}