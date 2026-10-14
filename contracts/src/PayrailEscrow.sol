// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title PayrailEscrow
/// @notice Outcome-based escrow for pay-per-qualifying-response API calls. UNAUDITED. NOT DEPLOYED.
///
/// Flow: a buyer deposits a stablecoin; the operator (Payrail's backend) places a HOLD for one request, then either
/// CAPTUREs it (the response met the contract: seller earns price minus fee) or RELEASEs it (buyer gets it back).
/// A hold nobody resolves can be released to the buyer by anyone after `holdTimeout`.
///
/// TRUST ASSUMPTIONS (read before relying on this):
///  - The operator decides which holds are captured vs released, and WHICH SELLER a hold pays. It cannot take a buyer's
///    funds to itself except by naming itself (or an accomplice) as the seller of a hold. Buyers should therefore only
///    keep on deposit what they intend to spend, and can `withdraw` any available balance at any time.
///  - The contract cannot check an API response; "qualifying" is the operator's attestation, backed off-chain by the
///    contract version and evidence Payrail stores. This is not trustless outcome verification.
///  - The fee rate is fixed at deployment and capped at MAX_FEE_BPS.
contract PayrailEscrow {
    uint16 public constant MAX_FEE_BPS = 1_000; // 10%

    IERC20 public immutable token;
    address public immutable operator;
    address public immutable feeRecipient;
    uint16 public immutable feeBps;
    uint64 public immutable holdTimeout;

    mapping(address => uint256) public available; // buyer funds not on hold
    mapping(address => uint256) public earnings; // seller (and fee recipient) claimable funds

    enum State { None, Held, Captured, Released }

    struct Hold {
        address buyer;
        address seller;
        uint256 amount;
        uint64 createdAt;
        State state;
    }

    mapping(bytes32 => Hold) public holds;

    /// @dev total owed by this contract; always equals the token balance unless tokens were sent here directly
    uint256 public totalLiabilities;

    event Deposited(address indexed buyer, uint256 amount);
    event Withdrawn(address indexed buyer, uint256 amount);
    event HoldPlaced(bytes32 indexed id, address indexed buyer, address indexed seller, uint256 amount);
    event Captured(bytes32 indexed id, address indexed seller, uint256 sellerAmount, uint256 feeAmount);
    event Released(bytes32 indexed id, address indexed buyer, uint256 amount, bool expired);
    event Claimed(address indexed account, uint256 amount);

    error NotOperator();
    error ZeroAmount();
    error InsufficientBalance();
    error HoldExists();
    error HoldNotOpen();
    error NotExpired();
    error TransferFailed();
    error Reentrancy();
    error BadConfig();

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(IERC20 token_, address operator_, address feeRecipient_, uint16 feeBps_, uint64 holdTimeout_) {
        if (address(token_) == address(0) || operator_ == address(0) || feeRecipient_ == address(0)) revert BadConfig();
        if (feeBps_ > MAX_FEE_BPS || holdTimeout_ < 1 hours) revert BadConfig();
        token = token_;
        operator = operator_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        holdTimeout = holdTimeout_;
    }

    // ------------------------------------------------------------ buyer

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        available[msg.sender] += amount;
        totalLiabilities += amount;
        _pull(msg.sender, amount);
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (available[msg.sender] < amount) revert InsufficientBalance();
        available[msg.sender] -= amount;
        totalLiabilities -= amount;
        _push(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------ operator

    function placeHold(bytes32 id, address buyer, address seller, uint256 amount) external onlyOperator {
        if (amount == 0) revert ZeroAmount();
        if (holds[id].state != State.None) revert HoldExists();
        if (available[buyer] < amount) revert InsufficientBalance();
        available[buyer] -= amount;
        holds[id] = Hold(buyer, seller, amount, uint64(block.timestamp), State.Held);
        emit HoldPlaced(id, buyer, seller, amount);
    }

    /// @notice The response qualified: seller earns price minus fee (fee rounded half up, as in the off-chain ledger).
    function capture(bytes32 id) external onlyOperator {
        Hold storage h = holds[id];
        if (h.state != State.Held) revert HoldNotOpen();
        h.state = State.Captured;
        uint256 fee = (h.amount * feeBps + 5_000) / 10_000;
        uint256 sellerAmount = h.amount - fee;
        earnings[h.seller] += sellerAmount;
        earnings[feeRecipient] += fee;
        emit Captured(id, h.seller, sellerAmount, fee);
    }

    /// @notice The response did not qualify: the buyer gets the full amount back.
    function release(bytes32 id) external onlyOperator {
        _release(id, false);
    }

    // ------------------------------------------------------------ anyone

    /// @notice A hold that was never resolved returns to the buyer after `holdTimeout`. Buyer-favourable by design.
    function expire(bytes32 id) external {
        Hold storage h = holds[id];
        if (h.state != State.Held) revert HoldNotOpen();
        if (block.timestamp < uint256(h.createdAt) + holdTimeout) revert NotExpired();
        _release(id, true);
    }

    // ------------------------------------------------------------ sellers / fee recipient

    function claim() external nonReentrant {
        uint256 amount = earnings[msg.sender];
        if (amount == 0) revert ZeroAmount();
        earnings[msg.sender] = 0;
        totalLiabilities -= amount;
        _push(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // ------------------------------------------------------------ internals

    function _release(bytes32 id, bool expired) private {
        Hold storage h = holds[id];
        if (h.state != State.Held) revert HoldNotOpen();
        h.state = State.Released;
        available[h.buyer] += h.amount;
        emit Released(id, h.buyer, h.amount, expired);
    }

    /// @dev tolerant of tokens (like USDT) whose transfer functions return no value
    function _pull(address from, uint256 amount) private {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _push(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}
