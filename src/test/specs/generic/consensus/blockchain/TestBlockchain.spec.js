class TestBlockchain extends FullChain {
    static get MAX_NUM_TRANSACTIONS() {
        return Math.floor(              // round off
            (Policy.BLOCK_SIZE_MAX -    // block size limit
            150 -                       // header size
            20) /                       // miner address size
            165);                       // transaction size

    }

    constructor(store, accounts, users, ignorePoW = false) {
        // XXX Set a large timeout when mining on demand.
        if (TestBlockchain.MINE_ON_DEMAND && jasmine && jasmine.DEFAULT_TIMEOUT_INTERVAL) {
            jasmine.DEFAULT_TIMEOUT_INTERVAL = 1200000;
        }

        super(store, accounts);
        this._users = users;
        this._invalidNonce = ignorePoW;
        return this._init();
    }

    get accounts() {
        return this._accounts;
    }

    get users() {
        return this._users;
    }

    static async createTransaction(senderPubKey, recipientAddr, amount = 1, fee = 1, nonce = 0, senderPrivKey = undefined, signature = undefined) {
        const transaction = new Transaction(senderPubKey, recipientAddr, amount, fee, nonce);

        // allow to hardcode a signature
        if (!signature) {
            // if no signature is provided, the secret key is required
            if (!senderPrivKey) {
                throw 'Signature computation requested, but no sender private key provided';
            }
            signature = await Signature.create(senderPrivKey, senderPubKey, transaction.serializeContent());
        }
        transaction.signature = signature;

        return transaction;
    }

    // TODO can still run into balance problems: block height x and subsequent `mining` means that only the first x
    // users are guaranteed to have a non-zero balance. Depending on the existing transactions, this can improve a bit...
    async generateTransactions(numTransactions, noDuplicateSenders = true, sizeLimit = true) {
        const numUsers = this.users.length;

        if (noDuplicateSenders && numTransactions > numUsers) {
            // only one transaction per user
            numTransactions = numUsers;
        }

        if (sizeLimit && numTransactions > TestBlockchain.MAX_NUM_TRANSACTIONS) {
            Log.w(`Reducing transactions from ${numTransactions} to ${TestBlockchain.MAX_NUM_TRANSACTIONS} to avoid exceeding the size limit.`);
            numTransactions = TestBlockchain.MAX_NUM_TRANSACTIONS;
        }

        /* Note on transactions and balances:
         We fill up the balances of users in increasing order, therefore the size of the chain determines how many
         users already have a non-zero balance. Hence, for block x, all users up to user[x] have a non-zero balance.
         At the same time, there must not be more than one transaction from the same sender.
         */
        const transactions = [];
        for (let j = 0; j < numTransactions; j++) {
            const sender = this.users[j % numUsers];
            const recipient = this.users[(j + 1) % numUsers];

            // 10% transaction + 5% fee
            const balanceValue = (await this.accounts.getBalance(sender.address)).value; // eslint-disable-line no-await-in-loop
            const amount = Math.floor(balanceValue / 10) || 1;
            const fee = Math.floor(amount / 2);
            const nonce = j;

            const transaction = await TestBlockchain.createTransaction(sender.publicKey, recipient.address, amount, fee, nonce, sender.privateKey);// eslint-disable-line no-await-in-loop

            transactions.push(transaction);
        }

        return transactions.sort((a, b) => a.compare(b));
    }

    /**
     * @param {{prevHash, interlinkHash, bodyHash, accountsHash, nBits, timestamp, nonce, height, interlink, minerAddr, transactions, numTransactions}} options
     * @returns {Promise.<Block>}
     */
    async createBlock(options = {}) {
        const height = options.height || this.head.height + 1;

        let transactions = options.transactions;
        if (!transactions) {
            const numTransactions = typeof options.numTransactions !== 'undefined' ? options.numTransactions : height - 1;
            transactions = await this.generateTransactions(numTransactions);
        }

        const minerAddr = options.minerAddr || this.users[this.height % this._users.length].address;     // user[0] created genesis, hence we start with user[1]
        const body = new BlockBody(minerAddr, transactions);

        const nBits = options.nBits || BlockUtils.targetToCompact(await this.getNextTarget());
        const interlink = options.interlink || await this.head.getNextInterlink(BlockUtils.compactToTarget(nBits));

        const prevHash = options.prevHash || this.headHash;
        const interlinkHash = options.interlinkHash || await interlink.hash();
        const bodyHash = options.bodyHash || await body.hash();

        let accountsHash = options.accountsHash;
        if (!accountsHash) {
            const accountsTx = await this._accounts.transaction();
            try {
                await accountsTx.commitBlockBody(body);
                accountsHash = await accountsTx.hash();
            } catch (e) {
                // The block is invalid, fill with broken accountsHash
                accountsHash = new Hash(null);
            }
            await accountsTx.abort();
        }

        const timestamp = typeof options.timestamp !== 'undefined' ? options.timestamp : this.head.timestamp + Policy.BLOCK_TIME;
        const nonce = options.nonce || 0;
        const header = new BlockHeader(prevHash, interlinkHash, bodyHash, accountsHash, nBits, height, timestamp, nonce);

        const block = new Block(header, interlink, body);
        const hash = await block.hash();
        TestBlockchain.BLOCKS[hash.toBase64()] = block;

        if (nonce === 0) {
            if (TestBlockchain.NONCES[hash.toBase64()]) {
                block.header.nonce = TestBlockchain.NONCES[hash.toBase64()];
                if (!(await block.header.verifyProofOfWork())) {
                    throw new Error(`Invalid nonce specified for block ${hash}: ${block.header.nonce}`);
                }
            } else if (TestBlockchain.MINE_ON_DEMAND) {
                console.log(`No nonce available for block ${hash.toHex()}, will start mining at height ${block.height} following ${block.prevHash.toHex()}.`);
                await TestBlockchain.mineBlock(block);
                TestBlockchain.NONCES[hash.toBase64()] = block.header.nonce;
            } else if (this._invalidNonce) {
                console.log(`No nonce available for block ${hash.toHex()}, but accepting invalid nonce.`);
            } else {
                throw new Error(`No nonce available for block ${hash}: ${block}`);
            }
        }

        return block;
    }

    static async createVolatileTest(numBlocks, numUsers = 2, ignorePoW = false) {
        const accounts = await Accounts.createVolatile();
        const store = ChainDataStore.createVolatile();
        const users = await TestBlockchain.getUsers(numUsers);
        const testBlockchain = await new TestBlockchain(store, accounts, users, ignorePoW);

        // populating the blockchain
        for (let i = 0; i < numBlocks; i++) {
            const newBlock = await testBlockchain.createBlock(); //eslint-disable-line no-await-in-loop
            const success = await testBlockchain.pushBlock(newBlock); //eslint-disable-line no-await-in-loop
            if (success !== FullChain.OK_EXTENDED) {
                throw 'Failed to commit block';
            }
        }

        return testBlockchain;
    }

    static async getUsers(count) {
        if (count > TestBlockchain.USERS.length) {
            throw `Too many users ${count} requested, ${TestBlockchain.USERS.length} available`;
        }

        const users = [];
        const keyPairs = TestBlockchain.USERS.slice(0, count)
            .map(encodedKeyPair => KeyPair.unserialize(BufferUtils.fromBase64(encodedKeyPair)));
        for (const keyPair of keyPairs) {
            const address = await keyPair.publicKey.toAddress(); // eslint-disable-line no-await-in-loop
            users.push(TestBlockchain.generateUser(keyPair, address));
        }
        return users;
    }

    static async generateUsers(count) {
        const users = [];

        // First user, it needs to be known beforehand because the
        // genesis block will send the first miner reward to it.
        // This keypair is the one that the miner address of the test genesis block in DummyData.spec.js belongs to.
        const keys = KeyPair.unserialize(BufferUtils.fromBase64(TestBlockchain.USERS[0]));
        const address = await keys.publicKey.toAddress();
        users.push(TestBlockchain.generateUser(keys, address));

        for (let i = 1; i < count; i++) {
            const keyPair = await KeyPair.generate(); //eslint-disable-line no-await-in-loop
            const address = await keyPair.publicKey.toAddress(); //eslint-disable-line no-await-in-loop

            users.push(TestBlockchain.generateUser(keyPair, address));
        }
        return users;
    }

    static generateUser(keyPair, address) {
        return {
            'keyPair': keyPair,
            'privateKey': keyPair.privateKey,
            'publicKey': keyPair.publicKey,
            'address': address
        };
    }

    static async mineBlock(block) {
        await TestBlockchain._miningPool.start();
        block.header.nonce = 0;
        const share = await new Promise((resolve) => {
            const temp = function (share) {
                if (share.blockHeader.equals(block.header)) {
                    TestBlockchain._miningPool.off('share', temp.id);
                    resolve(share);
                }
            };
            temp.id = TestBlockchain._miningPool.on('share', temp);
            TestBlockchain._miningPool.startMiningOnBlock(block.header);
        });
        TestBlockchain._miningPool.stop();
        block.header.nonce = share.nonce;
        if (!(await block.header.verifyProofOfWork())) {
            throw 'While mining the block was succesful, it is still considered invalid.';
        }
        return share.nonce;
    }

    static mineBlocks() {
        const nonces = {};
        const promises = [];
        for (const hash in TestBlockchain.BLOCKS) {
            if (TestBlockchain.NONCES[hash]) {
                nonces[hash] = TestBlockchain.NONCES[hash];
            } else {
                promises.push(TestBlockchain.mineBlock(TestBlockchain.BLOCKS[hash]).then(nonce => nonces[hash] = nonce));
            }
        }
        return Promise.all(promises).then(() => nonces);
    }

    static async mineBlocksJSON() {
        TestBlockchain.NONCES = await TestBlockchain.mineBlocks();
        TestBlockchain.printNonces();
    }

    static printNonces() {
        const nonces = Object.assign({}, TestBlockchain.NONCES);
        for (const key of Object.keys(nonces)) {
            if (!TestBlockchain.BLOCKS[key]) {
                delete nonces[key];
            }
        }
        TestBlockchain._printNonces(nonces);
    }

    static _printNonces(nonces) {
        // XXX Primitive JSON pretty printer
        const json = JSON.stringify(nonces)
            .replace(/"/g, '\'')
            .replace(/:/g, ': ')
            .replace(/,/g, ',\n    ')
            .replace(/{/g, '{\n    ')
            .replace(/}/g, '\n}');
        console.log(json);
    }

}
TestBlockchain._miningPool = new MinerWorkerPool(4);

TestBlockchain.MINE_ON_DEMAND = false;

TestBlockchain.BLOCKS = {};
TestBlockchain.USERS = [ // ed25519 keypairs
    'Mmu0+Ql691CyuqACL0IW9DMYIdxAQXCWUQV1/+Yi/KHbtdCeGGSaS+0SPOflF9EgfGx5S+ISSOhGHv1HOT3WbA==', // This keypair is the one that the miner address of the test genesis block in DummyData.spec.js belongs to.
    'HJ3XZfRDoPMpyEOZFQiETJSPxCTQ97Okyq8bSTIw4em1zS3x9PdeWBYwYcgBCl05/sni79TX9eu8FiZ9hWSruA==',
    'xSYRx3GM0DPFi9icVtzodvnjck/7qcc/92YTRVXcqALVtCnpK7PZYIYb2ZUp2Y+tW3DHg12Vk/FI1oLUIny8RA==',
    'dNxnxlHjOrthMRIFpWmaNMCccqjXrlO/eaD2g+1jvh8grFl7ZN/P102AYogOWBGZayH74Fcf2KSfy1/rDlFMrg==',
    'JDfN8h0RHx51lMyY29UQcLjQR7ig9URcPPdxhRclhk/Wht9pnUIRXtzYWw742hlaOhJzkuOqqLg2oEM33hIV3Q==',
    'OBZNFtzBjrJwaYq3A+sB0zpGscmYaIHrULfP36LT+5+sF/roKPCiXMcqT7OcAfnNCfzo+x7cxaqcoNEm2+VDVA==',
    'LkC2ULxwljHcM4sFe6yA1eaYHPoPl4j2kh+5qtzPNr1vR95be3os01XpsINXwDHNucuevBGmzyJYbwgcUsFRiA==',
    '2r62ml0RiVd+Wxb/Ef3QsNuCkElNgit6+VQpiPg5Vo8jLY4WEX/L1OL/pJOvLfsnIvb+HTOmCA6M4vpOJRb59g==',
    'kVuy+yezfkkaTRxT47bLMID+JzvyTD3LzQEJTKk8X/RMJaaGSYsDiz68fxtS6m+SSdv1MUSogYz07K3wdr+nng==',
    '8+P/0UlVK/jlFVQBK9Lr4cv4sLXVLiL8T/ahU0wXOYD9hAwqH2/GX7ghf8pO+0AcyBPbBBh+Wy7GgKxFLZ1YdA==',
    'vR8sgRd+wa+n7ymTHB77h2TS91JTvp8pJSH7/c/dZlL91+BMMuXbSr7MBjEPw1rf7qULOts+/zAvnfY/IYsnJA==',
    '1R/x+Mb9PtWkyv3nZpyL1QT19hGj6QaH7cHd0yArZWhl7aiwZ4exu9uX96/TsxgXRX4LA5tZ895IXswXZvnDBg==',
    'aRBGIzF50FEWQoStq/hwKl/50YqvqjSxkBUu9BJ4HVYEZEQdbKu1JDr6/DX8gIT9mC2TQZriK7VNMUVXfSEhPQ==',
    'Uub9Wb4pzoX2cEKwJErP5LoqELtRFeF5BRnW4Y9lZRJNQwmIYnUr6uFb50o2aN4iYlq1s1GsAE8c9gZyTsO6IA==',
    'GfC3EOtTnlMM0z7A8dnwKuA4y1DSIQuwCs8FFRYrhL6lVs4r5QQSJlnuhYjGFSE5m+3392ELkvYNmEQL28u9Mg==',
    'lxFSrIseX4bGZYJY/FrWjEtFZ4coJucoIjab9jc8675mTwkPuB7t7BCmaPPN67WxQFD0Qj5vw1NUQ66q1SrtdA==',
    'zGLx8jnMMGP5T7enK/BQTPc47vuzl+yy07Wcs161wGK0Q5uSlGK6IfF50MRgs1Wn0sNeLqbILEk/KIZUy07erA==',
    'I+zEE/RCxbLOtRA90bVu+zrqFg7nS6MUTn+2f5fbQ3O9jio9dwuFTkrgVLEGe9QbvVGC7NP3bIsjwNvgx3q2eQ==',
    '1Oz7m7esArq2k0AXqHxUwjFcI8DGfR63MUUMuGuvcG+GP7VA5dw5NlR3i2uF5kHEy9wWB64iz/hP9RxXItJAnA==',
    'X/06OWBfaMkHRPjtbzSXx2A1BcrJy6mUl7ndXiqAjK/FHSMI64mJ0VpPR3d8QwphDDUfaHHKt8in26vvUKCUIA==',
    '6krkaWJRA/BrSXjU+dAzRGq9DtNjEEGR45gF0Obyv5elzSSGnO5+VgGItN2StcKfdpmkLFSFm91Na34FEywIsA==',
    'rUjEeM4Hj1xI/GKenLd335fIn4/+wYTqTQB0G6W+AxIzp1fnNY5AMusg8+fab3f6j5DVJDy9OCif5ZiP4RjaBA==',
    'RqaLfBj53rhPWZggf9l7OGyf1QvYazUoHCrep9lKNcn82XSH1cQbTuaGo0YRkpJlSp029uG70LOm//whFGSiag==',
    'YhnMyCfXwdIRcul1TAZbBU7IsASMlC/2Vhmr/gwFjiMi1OlO3DNdnzd70aOHzoYyXSxdtqWGKcEGOn/AtgUSaw==',
    'g2/wZc1CCHBZAajOs0yHBiIj+YTBKf2kFqg4feCj6qNy5yilcUR752g6MC3pV0scZbEzqLzK1kZ5tnxOjbZYJw=='
];
TestBlockchain.NONCES = {
    'ijrnQnCKLl2nD/yEl2EsvH8JDJPtrkR+mfykofz8/tg=': 77059,
    'ATtCeswG5Ka5adeIhV8W6kSzLNBWlVdh4gLODNv9jEQ=': 21728,
    'vY198ptSJ5udQS+KcrH0YtaEJoz6TnfU+ch5H9DEILY=': 54184,
    'kkff4RHFxLUbbqfhM28+JVxnUgdthCjJuc29M9XxUu0=': 134169,
    'ZPOjUfDY6yUqLTo+9uLtiwkn9tGhGXn1bGdrpwnnzz8=': 42109,
    'OWck6ejqk8DCct3UTZ5zja/3zF7pfCnycfCCiG+hq7c=': 65140,
    'YluIY+G4OQiODbNx7zBNJ2GOKL1ZodR2M5M+j0WHlhE=': 34502,
    'TDoQ69zouPKpsNWmX2Nhllj1hb53mgZEJrP2Mwgo3Qg=': 28326,
    'Lk3zWiL/QvSDD7ULS/EOq5u5qZyZEEYvUrD3f852q6w=': 18884,
    '7YLoKbnn0nSZIGQqMwUCeebMB6/ZZY9AK9XEhL0Gsj8=': 8714,
    'znXh6DtbGg0gAtCB6j5tvtS9xrYjdSF4GdR9QLXvjI8=': 146810,
    '/Xo+Ki62Q1Q4wVrNPWhWVtjq6+wrVBEGTqMaC8hQbdQ=': 78916,
    'nKVOUJWcDg0lJOtMWkQ1wg4sBxtKewnj2IfrzrF1zbo=': 38311,
    'ro8F1ZAGJOCw5AP9YU1I98yJD0z/5fRuLAJg5bMcV2o=': 81175,
    'SOe10/fuquDocVMe/a9/gKpPmwm8NcMaeAZ9tS859ik=': 76225,
    'gEUA5pZ8LuxpuzdjzrrfpFTBAL1AoZYAoNyKFwbzOZk=': 17108,
    'rM9o4s0UDVX1wPHdE3Yg92QnW9QofRQsgoNHrtnzhGg=': 234532,
    'ExcpvgC9VZHNYj2vyBoGx13ILvPtYtp00kTMWEtUK/k=': 78940,
    'lr2C3rmbMlUr+FbCFrM65G5ixET4Sd7yig6GaD0xAJQ=': 4968,
    'jgQVlahaVJ0nZMqhtANx8BuS85Ez5560ofMFDUPD/KU=': 8155,
    'Em+5DvxzYsGZUlMEqVa7M+oOJZeDd8u8Oj83wN7GPkE=': 33805,
    'LOV4OjTeX9twS3Ga7YuccSCWlkMQxTkoRYGNJz7VyhQ=': 39527,
    'CEyysiLfxbUulzSwcatKVYHP4KcN+sNYUKSFGZVrNo4=': 172036,
    '6PedC6vODcjQu6O51q2Go5dvw2OwRpZVQa+l+Uh+rAY=': 62657,
    '5m+sX3SJd4RwtwGKA9AcqrdTcXbBQc4eltnR2UJI9Ho=': 32657,
    'sOBBIaTtur0S4VUWMAq26EkPhcWztUjTf53RADbnjLU=': 29865,
    'bYBrpZfIjmW3eW/XAkxnWzo3GPCrNQhwxD6FBPrFWw0=': 22820,
    'XcrHuSj6WqPuzKRv4tTZGJGSaH+cJynCmhBgTYKhrLY=': 319522,
    'XD4sDnhQx0KOqdzZhRhgvr2+Cb3iewMx8YlUDnjCif4=': 22430,
    'znYDxBjeAllnLU6I700zcmEY6Tgk9xBIzdfa3A4IypY=': 60989,
    '4e/t4UOFmIqW9+O63iN7kj4ULCa9kLVSuLm0uzL6nhQ=': 19046,
    'Yjh78CWH1hvq0UAxnbFPVSZ6pM+Ppv4mD+bqVqO29F4=': 6793,
    'ZDfh8myhk63VtIM89O0qotvv4yxmL/EN7rvskViJNh4=': 95500,
    'qOCr5l68AJfk5jj0sLYiRLnC8Qdpl6wjhqSb5KasYVo=': 92646,
    'FU1CoIoG+vs9F41HaiHKoNmNjwMtkl6KsRS1FYACe+M=': 58536,
    '3UTHDXWJUWmjUDGvBc1n8Cull8ctn5BND59f/8IoZs0=': 26318,
    'aCK2ZE6V34r5LHNh2Mx5dKK14fJm6DuSRh7OTE9pkZQ=': 177201,
    'h1eObYdxFTT1ZfdTopLfR3CooT51/bcpW4B6wR8ctBs=': 145393,
    'nveERAUpfGPeUwQgG4VDtpfZgRrR7WmxSGeJGZXKI+0=': 4268,
    'jyozdXhiXVHIZ7liXT/Cw+7nkGcYOGueK6n1HhKhY4o=': 39331,
    'NXpt0dy+4wsOAkiUKfTPvG1kQXNHtD7FL0aBrLNsP1w=': 358238,
    'fYsXUSl0ZC15t2laEC5Mj6ThRSRLiyA+QFC33ApoHSo=': 50870,
    'c1SqxYV8fFL6CBGgHnGA8wjkPwJzbyC8pGWgzxEB170=': 31238,
    'wURSkSxDuZSPl4B8MbA0/q8Do8Wx7eEMIUPQ1x5XVao=': 102886,
    'sR0Q1MtF6NiE8N2qHPIb92xzAbrIV7NaaNIVzoIOo6s=': 32171,
    'KQ28RTz8v6oGO8ccZXLQkNE5T1YRbJBWyqtes58D76E=': 24574,
    'qeAFGMvO8PrMmfFTmrKgnjXTzKW9kyLfj66Bfze8uds=': 19891,
    '7UL67q2pbRKREbgciw02ZpFjGiNDDMW5czw7AojVQ9M=': 34008,
    'zQT31QXkhkkzj1dYEsdxA1OM80jpGipZRhqLKMrUcsM=': 20356,
    '7HW6eo9PZmzxvEOOCU9f06KMk3/L7OLDPK5V52L/j+M=': 11904,
    '/tvxs7mLw3HtIsxey4NNQ1oI4ZkcT+dbvTROmjsR/gw=': 640,
    'QMjwMEkyFqT1f8vcLGX5kuVN0aCJpwE1gtXIOp5yhmY=': 36930,
    'o1BEzg3Q5/azJ4KgSgL2Pz5VuTKAi+ncf9pdAldqSlY=': 118035,
    'Kbfu7Q9xGgrzsVuBqxFEUj+euV+gv7NO7pyY1iNhoto=': 71538,
    'q7YC6P6sQGGaxCqxKep7a2xkWTZ6X7u+sxtqY9Qj1rY=': 29060,
    'TPs9vN6s5Ex4geM8RcdVt/gIT3+UjsjBZX/9Ocg0PvM=': 32799,
    'NquSfbuqfjwJSob7tkG1yfLLi7fRFm9UZGmVQDV89SQ=': 171987,
    'e5v7qXUx8ghrXfAGR2LsP6Naq7VWse/8lGGSzoGQo9I=': 26445,
    'z7OFJsTR3U9Gady6ZBlFRmwC2p4SrybQKDEXI5QD25w=': 52618,
    'tA/zopMxMid/ge6iIRK9WTEj5zQxpcY3BwaZxAgsPLY=': 33941,
    'jBAdl5CKVxxEAfnU5XPe4EzdyrmPxYpUHUaHeiYTsh0=': 22986,
    'th/B8p3r8ex/SzO176QKcJBrGEHaYar4dkyF9/8mWis=': 66376,
    't1VCFchy3Hd3HbXTntEF1hWG9ah2W5rkG4HSdk429Ww=': 30742,
    'OK4V+gS/jJQBQ4JV784VqPjkDe7TrnEfZ+zNpPXg2zk=': 10165,
    'QxmcS1IOpjiarn3H0n7YDo+jfKKVkbILYG77tRXmTb8=': 124230,
    'YcvA3hlLiRMjKpcYr8/NYQaUwhqfC1Z1DlZFWwTERDk=': 21578,
    'tLNC6AQO+53vqys3oJ9hIwEH5mXLENkIB18VKMYiBhg=': 37534,
    'lI/A3WSu5PlSMwTFF6Lgmg9KZnNBqhh04s3dgFoLRTI=': 1293,
    '1/SewvtqBmgC3LMPN+Han6L4913WZpH9qgm6denbmc4=': 24976
};
Class.register(TestBlockchain);
